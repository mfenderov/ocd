package pair

import (
	"fmt"
	"net"
	"net/http"
	"os"

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

func Handler(st *store.Store, exec func() (string, error)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)
		if !authorized(r) {
			st.Audit("web:"+ip, "tap_denied", "", ip, "no-jwt")
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
			st.Audit("web:"+ip, "tap_denied", "", ip, "used-or-expired")
			http.Error(w, "link already used or expired", http.StatusGone)
			return
		}
		st.Audit("web:"+ip, "tapped", device, ip, "ok")
		link, err := mint.Mint(st, exec, device, "web")
		if err != nil {
			st.Audit("web:"+ip, "mint_failed", device, ip, err.Error())
			if err == mint.ErrRateLimited {
				http.Error(w, "wait a bit before next link", http.StatusTooManyRequests)
				return
			}
			http.Error(w, "mint failed", http.StatusBadGateway)
			return
		}
		st.Audit("web:"+ip, "consumed", device, ip, "ok")
		http.Redirect(w, r, link, http.StatusFound)
		fmt.Fprint(w, link)
	})
}
