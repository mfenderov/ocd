package cli

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"time"

	"github.com/mfenderov/ocd/internal/boxadmin"
	"github.com/mfenderov/ocd/internal/boxagent"
	"github.com/mfenderov/ocd/internal/hook"
	"github.com/mfenderov/ocd/internal/pair"
	"github.com/mfenderov/ocd/internal/store"
	"github.com/mfenderov/ocd/internal/tg"
)

// heartbeatInterval paces box→Worker heartbeats (spec default).
const defaultHeartbeatInterval = 30 * time.Second

// heartbeatInterval resolves the box→Worker heartbeat pace.
// OCD_HEARTBEAT_INTERVAL overrides the 30s spec default with a Go duration
// string (e.g. "50ms"); it exists only so tests can tick fast, alongside
// OCD_SERVE_ADDR. Empty, unparsable, or non-positive values fall back to
// the default.
func heartbeatInterval() time.Duration {
	if raw := os.Getenv("OCD_HEARTBEAT_INTERVAL"); raw != "" {
		if d, err := time.ParseDuration(raw); err == nil && d > 0 {
			return d
		}
	}
	return defaultHeartbeatInterval
}

// serveAddr is the loopback listener for the daemon. OCD_SERVE_ADDR exists
// only so tests can bind a free port; production always uses the default.
func serveAddr() string {
	if a := os.Getenv("OCD_SERVE_ADDR"); a != "" {
		return a
	}
	return "127.0.0.1:49400"
}

// mountAdmin puts /admin/* behind Bearer auth when OCD_ADMIN_TOKEN is set.
// An unset token skips mounting cleanly: the daemon stays healthy without
// an admin listener, and the skip is logged for the boot log.
func mountAdmin(mux *http.ServeMux, w io.Writer, st *store.Store, execPair func() (string, error)) {
	token := os.Getenv("OCD_ADMIN_TOKEN")
	if token == "" {
		_, _ = fmt.Fprintln(w, "admin off (OCD_ADMIN_TOKEN unset)")
		return
	}
	publicBase := os.Getenv("OCD_PUBLIC_URL")
	if publicBase == "" {
		publicBase = "https://oc-tap.buyallmemes.com/pair"
	}
	execService := func(name string, args ...string) (string, error) {
		out, err := exec.Command(name, args...).Output()
		return string(out), err
	}
	mux.Handle("/admin/mint", boxadmin.RequireAdmin(st, token, boxadmin.MintHandler(st, execPair, publicBase)))
	mux.Handle("/admin/revoke", boxadmin.RequireAdmin(st, token, boxadmin.RevokeHandler(st, execService)))
	mux.Handle("/admin/audit", boxadmin.RequireAdmin(st, token, boxadmin.AuditHandler(st)))
	mux.Handle("/admin/presence", boxadmin.RequireAdmin(st, token, boxadmin.PresenceHandler(st)))
	_, _ = fmt.Fprintln(w, "admin on (/admin/* behind Bearer auth)")
}

// startHeartbeat POSTs one box heartbeat to the Worker every heartbeatInterval
// when OCD_WORKER_URL is set, with an immediate first beat so the fleet sees
// the box without waiting out the interval. An unset URL skips cleanly with
// a log line and no goroutine. The bearer is OCD_HEARTBEAT_TOKEN and
// OCD_ENROLL_TOKEN rides along until the Worker replies enrolled; neither
// secret is ever logged. workerURL is posted verbatim (full endpoint).
func startHeartbeat(ctx context.Context, w io.Writer, st *store.Store) {
	workerURL := os.Getenv("OCD_WORKER_URL")
	if workerURL == "" {
		_, _ = fmt.Fprintln(w, "heartbeat off (OCD_WORKER_URL unset)")
		return
	}
	interval := heartbeatInterval()
	_, _ = fmt.Fprintln(w, "heartbeat on (every "+interval.String()+")")
	client := &http.Client{} // dedicated: SendOnce clones it, never shares or mutates
	go func() {
		tick := time.NewTicker(interval)
		defer tick.Stop()
		enrolled := false
		send := func() {
			enrollToken := ""
			if !enrolled {
				enrollToken = os.Getenv("OCD_ENROLL_TOKEN")
			}
			ok, err := boxagent.SendOnce(st, client, workerURL, os.Getenv("OCD_BOX_ID"), os.Getenv("OCD_HEARTBEAT_TOKEN"), enrollToken, boxadmin.Version)
			if err != nil {
				_, _ = fmt.Fprintln(w, "heartbeat failed:", err)
				return
			}
			if ok {
				enrolled = true
			}
		}
		send()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				send()
			}
		}
	}()
}

func RunServe(w io.Writer) error {
	tgOn := true
	switch tok, owner := os.Getenv("OCD_TG_TOKEN"), os.Getenv("OCD_OWNER_ID"); {
	case tok == "" && owner == "":
		// Secondary boxes (fleet heartbeat + admin only): the single bot
		// stays on the primary box, polling twice would fight over updates.
		tgOn = false
		_, _ = fmt.Fprintln(w, "telegram off (OCD_TG_TOKEN and OCD_OWNER_ID unset)")
	case tok == "" || owner == "":
		return fmt.Errorf("ocd: half-configured telegram (need both OCD_TG_TOKEN and OCD_OWNER_ID, or neither)")
	}
	st, err := openStore()
	if err != nil {
		return err
	}
	defer st.Close()

	execPair := func() (string, error) {
		url := os.Getenv("OCD_PAIR_URL")
		if url == "" {
			url = "https://oc.buyallmemes.com"
		}
		out, err := exec.Command("opencode", "pair", "--url", url).Output()
		return string(out), err
	}

	ctx := context.Background()

	hookPath, hookSecret := "", ""
	poll := true
	if tgOn {
		hookPath, hookSecret = setupWebhook(ctx, w, st)
		poll = hookPath == ""
		go func() {
			if err := tg.Start(ctx, st, poll); err != nil {
				_, _ = fmt.Fprintln(w, "telegram:", err)
			}
		}()
	}

	mux := http.NewServeMux()
	mux.Handle("/pair", pair.Handler(st, execPair))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprint(w, "ok")
	})
	mountAdmin(mux, w, st, execPair)
	startHeartbeat(ctx, w, st)

	if shouldManageTunnel() {
		go runTunnel(ctx, w)
	}

	if !tgOn {
		_, _ = fmt.Fprintln(w, "mode: telegram off")
	} else if poll {
		_, _ = fmt.Fprintln(w, "mode: polling")
	} else {
		mux.Handle("/webhook/"+hookPath, hook.Handler(st, hookSecret, st.SeenUpdate,
			func(chatID, fromID int64, chatType, text string) {
				tg.Dispatch(ctx, st, chatID, fromID, chatType, text)
			}))
		_, _ = fmt.Fprintln(w, "mode: webhook (polling off)")
	}

	addr := serveAddr()
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintln(w, "ocd serve on http://"+ln.Addr().String())
	return http.Serve(ln, mux)
}

func newSecret() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func newPath() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// setupWebhook registers a rotating-UUID push path with Telegram.
// Empty public base or any failure means polling carries on alone.
func setupWebhook(ctx context.Context, w io.Writer, st *store.Store) (string, string) {
	base := os.Getenv("OCD_WEBHOOK_BASE")
	if base == "" {
		_, _ = fmt.Fprintln(w, "webhook off (OCD_WEBHOOK_BASE unset), polling only")
		return "", ""
	}
	secret, err := newSecret()
	if err != nil {
		_, _ = fmt.Fprintln(w, "webhook off (no entropy):", err)
		return "", ""
	}
	path, err := newPath()
	if err != nil {
		_, _ = fmt.Fprintln(w, "webhook off (no entropy):", err)
		return "", ""
	}
	url := base + "/webhook/" + path
	if err := tg.SetWebhook(ctx, url, secret); err != nil {
		_, _ = fmt.Fprintln(w, "webhook off (setWebhook failed, polling continues):", err)
		st.Audit("tg:owner", "webhook_failed", "", "", err.Error())
		return "", ""
	}
	st.Audit("tg:owner", "webhook_on", "", "", url)
	_, _ = fmt.Fprintln(w, "webhook on:", url)
	go func() {
		<-ctx.Done()
		_ = tg.DeleteWebhook(ctx)
	}()
	return path, secret
}
