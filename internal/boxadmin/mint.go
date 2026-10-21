package boxadmin

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/mfenderov/ocd/internal/mint"
	"github.com/mfenderov/ocd/internal/store"
)

// errNoClaim says the idempotency key could not be claimed: nobody won
// it and nobody served a live token for it.
var errNoClaim = errors.New("couldn't claim idempotency key")

// mintCaller is who asked for a mint: the address and the agent the
// audit row records.
type mintCaller struct {
	ip string
	ua string
}

// MintHandler mints one-time proxy tap-links for the fleet console.
// It requires an Idempotency-Key header (400 without one). Repeating a
// key returns the same proxy URL without running exec again while the
// first token is unclaimed and inside the link TTL (SQL-backed, so reuse
// survives restarts and holds across handler instances); a claimed or
// expired token — or a new key — mints fresh.
//
// Concurrency: each request issues its own token, then ClaimIdem keeps
// exactly one mapping per key atomically in SQL. Losers serve the
// winner's already-valid token, so the slow exec runs once per key with
// no waiting and no in-memory lock. Losers' unclaimed tokens stay valid
// but unmapped and age out via the store's link prune.
func MintHandler(st *store.Store, exec mint.Exec, publicBase string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		key := r.Header.Get("Idempotency-Key")
		if key == "" {
			http.Error(w, "missing idempotency key", http.StatusBadRequest)
			return
		}
		tok, err := st.IssueLink(ctx, "admin", "admin")
		if err != nil {
			http.Error(w, "couldn't issue a link", http.StatusInternalServerError)
			return
		}
		caller := mintCaller{ip: clientIP(r), ua: r.Header.Get("User-Agent")}
		served, err := claimMint(ctx, st, key, tok, exec, caller)
		if err != nil {
			writeMintError(w, err)
			return
		}
		// The base is the configured public origin and the token is hex
		// from the crypto/rand reader: nothing from the request reaches
		// the URL.
		//nolint:gosec // the URL is the configured origin plus a hex token.
		_, _ = fmt.Fprint(w, publicBase+"?t="+served)
	})
}

// claimMint claims the idempotency key and mints the link it names. It
// returns the token the console must serve: the winner's own token, or
// the one the winner already minted.
func claimMint(ctx context.Context, st *store.Store, key, tok string,
	exec mint.Exec, caller mintCaller) (string, error) {
	// At most two rounds: claim, else serve the owner's live URL.
	// A lost claim with nothing live means the owner released
	// after a failed mint, so our fresh token is claimable again.
	for range 2 {
		if st.ClaimIdem(ctx, key, tok) {
			return tok, mintPreflight(ctx, st, exec, key, tok, caller)
		}
		if live, ok := st.LookupIdem(ctx, key); ok {
			return live, nil
		}
	}
	return "", errNoClaim
}

// mintPreflight proves that pairing works before the link is served: the
// tap-time flow mints the delivered session, and only that session counts
// against the rate cap. The parsed link itself is not served: the console
// deals in one-tap proxy URLs only.
//
// A failed preflight gives the claim back: the next retry mints fresh.
func mintPreflight(ctx context.Context, st *store.Store, exec mint.Exec, key, tok string, caller mintCaller) error {
	if _, err := mint.Preflight(ctx, st, exec, "admin"); err != nil {
		st.ReleaseIdem(ctx, key, tok)
		st.ConsumeLink(ctx, tok)
		st.AuditUA(ctx, "admin", "mint_failed", "admin", caller.ip, err.Error(), caller.ua)
		return err
	}
	st.AuditUA(ctx, "admin", "link_issued", "admin", caller.ip, "ok", caller.ua)
	return nil
}

// writeMintError answers a mint that did not happen: the rate cap says
// wait, an unclaimable key says the console lost the race, anything else
// says the mint failed.
func writeMintError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, mint.ErrRateLimited):
		http.Error(w, "wait a bit before next link", http.StatusTooManyRequests)
	case errors.Is(err, errNoClaim):
		http.Error(w, errNoClaim.Error(), http.StatusInternalServerError)
	default:
		http.Error(w, "mint failed", http.StatusBadGateway)
	}
}
