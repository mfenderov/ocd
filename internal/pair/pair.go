package pair

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"

	"github.com/mfenderov/ocd/internal/geo"
	"github.com/mfenderov/ocd/internal/mint"
	"github.com/mfenderov/ocd/internal/store"
)

func stripPort(s string) string {
	s = strings.TrimSpace(strings.Split(s, ",")[0])
	if h, _, err := net.SplitHostPort(s); err == nil {
		return h
	}
	return s
}

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

func who(r *http.Request) string {
	return clientIP(r)
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
		st.SetUsedMeta(tok, clientIP(r), r.Header.Get("User-Agent"))
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
		rowID := st.AuditUA("web:"+ip, "consumed", device, ip, "ok", r.Header.Get("User-Agent"))
		go func() {
			if city := geo.Lookup(stripPort(ip)); city != "" {
				st.SetResultExtra(rowID, city)
			}
		}()
		http.Redirect(w, r, link, http.StatusFound)
		fmt.Fprint(w, link)
	})
}
