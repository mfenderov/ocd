package boxadmin

import (
	"errors"
	"fmt"
	"net/http"
	"sync"

	"github.com/mfenderov/ocd/internal/mint"
	"github.com/mfenderov/ocd/internal/store"
)

// MintHandler mints one-time proxy tap-links for the fleet console.
// It requires an Idempotency-Key header (400 without one). Repeating a
// key returns the same proxy URL without running exec again while the
// first token is unclaimed and inside the link TTL (SQL-backed, so reuse
// survives restarts); a claimed or expired token — or a new key — mints
// fresh. The mutex serializes lookup-mint-record so concurrent retries
// with one key still run exec once.
func MintHandler(st *store.Store, exec func() (string, error), publicBase string) http.Handler {
	var mu sync.Mutex
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("Idempotency-Key")
		if key == "" {
			http.Error(w, "missing idempotency key", http.StatusBadRequest)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if tok, ok := st.LookupIdem(key); ok {
			fmt.Fprint(w, publicBase+"?t="+tok)
			return
		}
		// Eager exec keeps mint rate-limit accounting in one place
		// (mint.Mint); the tap-time flow mints the delivered session.
		// The parsed link itself is not served: the console deals in
		// one-tap proxy URLs only.
		if _, err := mint.Mint(st, exec, "admin", "admin"); err != nil {
			if errors.Is(err, mint.ErrRateLimited) {
				http.Error(w, "wait a bit before next link", http.StatusTooManyRequests)
				return
			}
			http.Error(w, "mint failed", http.StatusBadGateway)
			return
		}
		tok, err := st.IssueLink("admin", "admin")
		if err != nil {
			http.Error(w, "couldn't issue a link", http.StatusInternalServerError)
			return
		}
		if err := st.RecordIdem(key, tok); err != nil {
			http.Error(w, "couldn't record idempotency key", http.StatusInternalServerError)
			return
		}
		fmt.Fprint(w, publicBase+"?t="+tok)
	})
}
