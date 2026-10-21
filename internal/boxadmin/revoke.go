package boxadmin

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/mfenderov/ocd/internal/admin"
	"github.com/mfenderov/ocd/internal/store"
)

// RevokeHandler rotates the server password via admin.Revoke and bumps the
// password epoch on success, returning {"epoch": N}. It requires a JSON body
// {"confirm": true} (400 otherwise) so the destructive call is never
// accidental. The exec argv is fixed inside admin.Revoke; nothing from the
// request reaches the command line.
func RevokeHandler(st *store.Store, exec admin.Exec) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Confirm bool `json:"confirm"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !body.Confirm {
			http.Error(w, "confirm required", http.StatusBadRequest)
			return
		}
		// Revoke runs to the end: a half-revoked box is worse than a
		// slow one, so the request's own cancellation does not reach it.
		ctx := context.WithoutCancel(r.Context())
		if err := admin.Revoke(ctx, st, exec); err != nil {
			http.Error(w, "revoke failed", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]int{"epoch": st.BumpEpoch(ctx)})
	})
}
