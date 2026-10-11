package boxadmin

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/mfenderov/ocd/internal/mint"
	"github.com/mfenderov/ocd/internal/store"
)

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
func MintHandler(st *store.Store, exec func() (string, error), publicBase string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("Idempotency-Key")
		if key == "" {
			http.Error(w, "missing idempotency key", http.StatusBadRequest)
			return
		}
		tok, err := st.IssueLink("admin", "admin")
		if err != nil {
			http.Error(w, "couldn't issue a link", http.StatusInternalServerError)
			return
		}
		// At most two rounds: claim, else serve the owner's live URL.
		// A lost claim with nothing live means the owner released
		// after a failed mint, so our fresh token is claimable again.
		for range 2 {
			if st.ClaimIdem(key, tok) {
				// Eager exec keeps mint rate-limit accounting in one
				// place (mint.Mint); the tap-time flow mints the
				// delivered session. The parsed link itself is not
				// served: the console deals in one-tap proxy URLs only.
				if _, err := mint.Mint(st, exec, "admin", "admin"); err != nil {
					st.ReleaseIdem(key, tok)
					if errors.Is(err, mint.ErrRateLimited) {
						http.Error(w, "wait a bit before next link", http.StatusTooManyRequests)
						return
					}
					http.Error(w, "mint failed", http.StatusBadGateway)
					return
				}
				fmt.Fprint(w, publicBase+"?t="+tok)
				return
			}
			if live, ok := st.LookupIdem(key); ok {
				fmt.Fprint(w, publicBase+"?t="+live)
				return
			}
		}
		http.Error(w, "couldn't claim idempotency key", http.StatusInternalServerError)
	})
}
