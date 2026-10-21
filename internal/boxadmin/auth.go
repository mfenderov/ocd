package boxadmin

import (
	"crypto/subtle"
	"net"
	"net/http"
	"strings"

	"github.com/mfenderov/ocd/internal/store"
)

func clientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		return strings.TrimSpace(strings.Split(fwd, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func RequireAdmin(st *store.Store, token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || token == "" || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			ip := clientIP(r)
			st.Audit(r.Context(), "web:"+ip, "admin_denied", "", ip, "bad-bearer")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
