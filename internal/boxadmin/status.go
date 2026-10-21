package boxadmin

import (
	"context"
	"io"
	"net/http"
	"time"

	"github.com/mfenderov/ocd/internal/admin"
	"github.com/mfenderov/ocd/internal/store"
)

// statusTimeout bounds the exec the status relay runs. The Worker's read
// deadline is 3s, so the box answers before it: a hung opencode comes
// back as a DOWN line instead of a timed-out relay. The exec also stops
// when the caller goes away — the brain's deadline cancels the Worker's
// fetch, and the box's exec follows the request.
const statusTimeout = 2 * time.Second

// StatusHandler serves the OpenCode service status for the brain: the
// same line the Go bot's /status prints, as plain text. The brain relays
// it when the owner asks whether the editor is up.
//
// The exec argv is fixed inside admin.Status; nothing from the request
// reaches the command line.
func StatusHandler(st *store.Store, exec admin.Exec) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), statusTimeout)
		defer cancel()
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, admin.Status(ctx, st, exec))
	})
}
