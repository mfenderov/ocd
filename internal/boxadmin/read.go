package boxadmin

import (
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/mfenderov/ocd/internal/store"
)

// ocdVersion is the box software version reported by the presence endpoint.
const ocdVersion = "0.3.0"

// auditJSON is the wire shape for one audit row. Keys are snake_case for
// the Worker consumer; the store type is left untouched.
type auditJSON struct {
	At     int64  `json:"at"`
	Actor  string `json:"actor"`
	Action string `json:"action"`
	Device string `json:"device"`
	IP     string `json:"ip"`
	Result string `json:"result"`
	UA     string `json:"ua"`
}

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
		out := make([]auditJSON, 0, len(rows))
		for _, row := range rows {
			out = append(out, auditJSON{
				At:     row.At,
				Actor:  row.Actor,
				Action: row.Action,
				Device: row.Device,
				IP:     row.IP,
				Result: row.Result,
				UA:     row.UA,
			})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
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
			"version":  ocdVersion,
			"taps_24h": st.CountRecentMints("", 24*time.Hour),
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
}
