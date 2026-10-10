package pair

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"

	"github.com/mfenderov/ocd/internal/mint"
	"github.com/mfenderov/ocd/internal/store"
)

func authorized(r *http.Request) bool {
	if os.Getenv("OCD_PAIR_OPEN") == "1" {
		return true
	}
	return r.Header.Get("Cf-Access-Jwt-Assertion") != ""
}

func clientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		return fwd
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// deviceHint reduces a User-Agent to a one-word client family for audit.
func deviceHint(ua string) string {
	l := strings.ToLower(ua)
	switch {
	case strings.Contains(l, "iphone"):
		return "iphone"
	case strings.Contains(l, "ipad"):
		return "ipad"
	case strings.Contains(l, "android"):
		return "android"
	case strings.Contains(l, "macintosh") || strings.Contains(l, "mac os"):
		return "mac"
	case strings.Contains(l, "windows"):
		return "windows"
	case strings.Contains(l, "linux"):
		return "linux"
	case strings.Contains(l, "curl"):
		return "curl"
	default:
		return "other"
	}
}

func who(r *http.Request) string {
	return clientIP(r) + " · " + deviceHint(r.Header.Get("User-Agent"))
}

func Handler(st *store.Store, exec func() (string, error)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := who(r)
		if !authorized(r) {
			st.AuditUA("web:"+ip, "tap_denied", "", ip, "no-jwt", r.Header.Get("User-Agent"))
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		tok := r.URL.Query().Get("t")
		if tok == "" {
			http.Error(w, "missing tap token", http.StatusBadRequest)
			return
		}
		device, ok := st.ConsumeLink(tok)
		if !ok {
			st.AuditUA("web:"+ip, "tap_denied", "", ip, "used-or-expired", r.Header.Get("User-Agent"))
			http.Error(w, "link already used or expired", http.StatusGone)
			return
		}
		st.SetUsedUA(tok, r.Header.Get("User-Agent"))
		st.AuditUA("web:"+ip, "tapped", device, ip, "ok", r.Header.Get("User-Agent"))
		link, err := mint.Mint(st, exec, device, "web")
		if err != nil {
			st.AuditUA("web:"+ip, "mint_failed", device, ip, err.Error(), r.Header.Get("User-Agent"))
			if err == mint.ErrRateLimited {
				http.Error(w, "wait a bit before next link", http.StatusTooManyRequests)
				return
			}
			http.Error(w, "mint failed", http.StatusBadGateway)
			return
		}
		st.AuditUA("web:"+ip, "consumed", device, ip, "ok", r.Header.Get("User-Agent"))
		http.Redirect(w, r, link, http.StatusFound)
		fmt.Fprint(w, link)
	})
}
