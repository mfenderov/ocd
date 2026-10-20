package boxadmin

import (
	"io"
	"net/http"

	"github.com/mfenderov/ocd/internal/admin"
	"github.com/mfenderov/ocd/internal/store"
)

// StatusHandler serves the OpenCode service status for the brain: the
// same line the Go bot's /status prints, as plain text. The brain relays
// it when the owner asks whether the editor is up.
//
// The exec argv is fixed inside admin.Status; nothing from the request
// reaches the command line.
func StatusHandler(st *store.Store, exec func(name string, args ...string) (string, error)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, admin.Status(st, exec))
	})
}
