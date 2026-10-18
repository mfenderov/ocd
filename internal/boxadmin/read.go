package boxadmin

import (
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/mfenderov/ocd/internal/store"
)

// Version is the single canonical box software version reported by the
// presence endpoint and sent in heartbeats. Callers (e.g. the serve
// heartbeat wiring) must use this, never a copy, so a bump lands once.
//
// It is a var, not a const, so goreleaser can stamp it at release time:
//
//	ldflags: -X github.com/mfenderov/ocd/internal/boxadmin.Version={{.Version}}
//
// Local/dev builds report "dev"; only stamped release binaries report tags.
var Version = "dev"

// AuditHandler serves recent audit rows as a JSON array. Query param n
// sets the row count (default 50, capped at 200). Nothing from the
// request reaches a shell: n is parsed as an integer only.
func AuditHandler(st *store.Store) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := 50
		if raw := r.URL.Query().Get("n"); raw != "" {
			if v, err := strconv.Atoi(raw); err == nil && v > 0 {
				n = v
			}
		}
		if n > 200 {
			n = 200
		}
		rows := st.RecentAudit(n)
		if rows == nil {
			rows = []store.AuditRow{}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(rows)
	})
}

// PresenceHandler reports box identity and liveness as JSON
// {"id","epoch","version","taps_24h"}. The box id comes from OCD_BOX_ID
// at request time so a cloned env is never baked in at construction.
func PresenceHandler(st *store.Store) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]any{
			"id":       os.Getenv("OCD_BOX_ID"),
			"epoch":    st.PasswordEpoch(),
			"version":  Version,
			"taps_24h": st.CountRecentMints("", 24*time.Hour),
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
}
