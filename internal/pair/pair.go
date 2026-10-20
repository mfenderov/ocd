package pair

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/mfenderov/ocd/internal/boxagent"
	"github.com/mfenderov/ocd/internal/geo"
	"github.com/mfenderov/ocd/internal/mint"
	"github.com/mfenderov/ocd/internal/store"
)

// pushTimeout bounds the event push to the brain. The push never holds a
// tap: it runs in its own goroutine and gives up after this long.
const pushTimeout = 3 * time.Second

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

// pushLinkUsed tells the brain that a tap consumed a link, so the brain can
// edit the message it owns. The push is best effort and off the tap's
// critical path: it runs in its own goroutine, a failure is recorded in the
// box's audit log, and the tapper never sees it. A box with no brain
// configured pushes nothing.
func pushLinkUsed(st *store.Store, tok, device, ip, ua string) {
	brainURL := os.Getenv("OCD_WORKER_URL")
	boxID := os.Getenv("OCD_BOX_ID")
	token := os.Getenv("OCD_HEARTBEAT_TOKEN")
	if brainURL == "" || boxID == "" || token == "" {
		return
	}
	go func() {
		// The request context dies with the tap, so the push gets its own.
		ctx, cancel := context.WithTimeout(context.Background(), pushTimeout)
		defer cancel()
		err := boxagent.PushEvents(ctx, &http.Client{}, brainURL, boxID, token, []boxagent.Event{{
			Type:  "link-used",
			Token: tok,
			IP:    ip,
			UA:    ua,
		}})
		if err != nil {
			st.AuditUA("box:"+boxID, "push_failed", device, ip, err.Error(), ua)
		}
	}()
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
		_, _ = fmt.Fprint(w, link)
		pushLinkUsed(st, tok, device, ip, r.Header.Get("User-Agent"))
	})
}
