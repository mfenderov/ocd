package boxadmin

import (
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/mfenderov/ocd/internal/mint"
	"github.com/mfenderov/ocd/internal/store"
)

// idemTTL mirrors the proxy-token TTL in internal/store: a repeated key
// reuses its URL only while the first token is still plausibly live.
const idemTTL = 10 * time.Minute

type idemEntry struct {
	token    string
	issuedAt time.Time
}

// MintHandler mints one-time proxy tap-links for the fleet console.
// It requires an Idempotency-Key header (400 without one). Repeating a
// key returns the same proxy URL without running exec again while the
// first token is within TTL; a new key mints fresh.
//
// NOTE: reuse state is process-local (per-handler map). The store package
// exposes no peek-validity or idem-table API, so claimed tokens are only
// noticed on tap (410) and reuse does not survive a restart. A store-level
// idem table is the follow-up; this keeps the retry-storm guarantee that
// matters here: one key, one exec, while the process lives.
func MintHandler(st *store.Store, exec func() (string, error), publicBase string) http.Handler {
	var mu sync.Mutex
	byKey := map[string]idemEntry{}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("Idempotency-Key")
		if key == "" {
			http.Error(w, "missing idempotency key", http.StatusBadRequest)
			return
		}
		mu.Lock()
		e, dup := byKey[key]
		mu.Unlock()
		if dup && time.Since(e.issuedAt) < idemTTL {
			fmt.Fprint(w, publicBase+"?t="+e.token)
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
		mu.Lock()
		byKey[key] = idemEntry{token: tok, issuedAt: time.Now()}
		mu.Unlock()
		fmt.Fprint(w, publicBase+"?t="+tok)
	})
}
