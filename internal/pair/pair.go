package pair

import (
	"context"
	"errors"
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
	cfg := boxagent.BrainConfigFromEnv()
	if !cfg.Ready() {
		return
	}
	go func() {
		// The request context dies with the tap, so the push gets its own.
		ctx, cancel := context.WithTimeout(context.Background(), pushTimeout)
		defer cancel()
		err := boxagent.PushEvents(ctx, &http.Client{}, cfg.BrainURL, cfg.BoxID, cfg.Token, []boxagent.Event{{
			Type:  "link-used",
			Token: tok,
			IP:    ip,
			UA:    ua,
		}})
		if err != nil {
			st.AuditUA(ctx, "box:"+cfg.BoxID, "push_failed", device, ip, err.Error(), ua)
		}
	}()
}

func Handler(st *store.Store, exec mint.Exec) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		ip := who(r)
		if !authorized(r) {
			st.AuditUA(ctx, "web:"+ip, "tap_denied", "", ip, "no-jwt", r.Header.Get("User-Agent"))
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		tok := r.URL.Query().Get("t")
		if tok == "" {
			http.Error(w, "missing tap token", http.StatusBadRequest)
			return
		}
		device, ok := st.ConsumeLink(ctx, tok)
		if !ok {
			st.AuditUA(ctx, "web:"+ip, "tap_denied", "", ip, "used-or-expired", r.Header.Get("User-Agent"))
			http.Error(w, "link already used or expired", http.StatusGone)
			return
		}
		st.SetUsedMeta(ctx, tok, clientIP(r), r.Header.Get("User-Agent"))
		st.AuditUA(ctx, "web:"+ip, "tapped", device, ip, "ok", r.Header.Get("User-Agent"))
		link, err := mint.Mint(ctx, st, exec, device, "web")
		if err != nil {
			st.AuditUA(ctx, "web:"+ip, "mint_failed", device, ip, err.Error(), r.Header.Get("User-Agent"))
			if errors.Is(err, mint.ErrRateLimited) {
				http.Error(w, "wait a bit before next link", http.StatusTooManyRequests)
				return
			}
			http.Error(w, "mint failed", http.StatusBadGateway)
			return
		}
		rowID := st.AuditUA(ctx, "web:"+ip, "consumed", device, ip, "ok", r.Header.Get("User-Agent"))
		go func() {
			// The lookup outlives the tap, so it does not take the tap's
			// cancellation with it.
			lookupCtx := context.WithoutCancel(ctx)
			if city := geo.Lookup(lookupCtx, stripPort(ip)); city != "" {
				st.SetResultExtra(lookupCtx, rowID, city)
			}
		}()
		// The link is what `opencode pair` printed: it is the tap's whole
		// point, and no request field reaches it.
		//nolint:gosec // the link comes from the pairing exec, not from the request.
		http.Redirect(w, r, link, http.StatusFound)
		//nolint:gosec // the link comes from the pairing exec, not from the request.
		_, _ = fmt.Fprint(w, link)
		pushLinkUsed(st, tok, device, ip, r.Header.Get("User-Agent"))
	})
}
