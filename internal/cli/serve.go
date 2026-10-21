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

// sweepInterval paces the box's sweep: the links that died and the audit
// rows that happened.
const sweepInterval = 30 * time.Second

// linkSweepBatch is how many dead links one sweep reports.
const linkSweepBatch = 50

// sweepPushTimeout bounds one push to the brain. The sweep must never
// hold the daemon hostage to a slow brain.
const sweepPushTimeout = 3 * time.Second

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

// mountAdmin puts the box API behind Bearer auth when OCD_ADMIN_TOKEN is set.
// The /_oc prefix avoids "/admin": Cloudflare's managed WAF challenges any path
// containing that segment, which would answer the worker instead of the box.
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
	execService := func(ctx context.Context, name string, args ...string) (string, error) {
		out, err := exec.CommandContext(ctx, name, args...).Output()
		return string(out), err
	}
	mux.Handle("/_oc/mint", boxadmin.RequireAdmin(st, token, boxadmin.MintHandler(st, execPair, publicBase)))
	mux.Handle("/_oc/revoke", boxadmin.RequireAdmin(st, token, boxadmin.RevokeHandler(st, func(name string, args ...string) (string, error) {
		// Revoke runs to the end: a half-revoked box is worse than a
		// slow one, so it gets no deadline.
		return execService(context.Background(), name, args...)
	})))
	mux.Handle("/_oc/audit", boxadmin.RequireAdmin(st, token, boxadmin.AuditHandler(st)))
	mux.Handle("/_oc/presence", boxadmin.RequireAdmin(st, token, boxadmin.PresenceHandler(st)))
	mux.Handle("/_oc/status", boxadmin.RequireAdmin(st, token, boxadmin.StatusHandler(st, execService)))
	_, _ = fmt.Fprintln(w, "admin on (/_oc/* behind Bearer auth)")
}

// startSweep tells the brain what happened on this box: which links died
// and which audit rows were written. Every interval it pushes one batch of
// dead links and one batch of audit rows. The brain owns the messages and
// the history, so the box only reports what happened.
//
// The sweep runs in the background and never blocks the daemon. A box
// with no brain configured sweeps nothing: the log line says so and no
// goroutine starts.
func startSweep(ctx context.Context, w io.Writer, st *store.Store, interval time.Duration) {
	cfg := boxagent.BrainConfigFromEnv()
	if !cfg.Ready() {
		_, _ = fmt.Fprintln(w, "sweep off (no brain configured)")
		return
	}
	_, _ = fmt.Fprintln(w, "link sweep on (every "+interval.String()+")")
	_, _ = fmt.Fprintln(w, "audit push on (every "+interval.String()+")")
	client := &http.Client{} // dedicated: PushEvents clones it, never shares or mutates
	go func() {
		tick := time.NewTicker(interval)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				sweepDeadLinks(ctx, w, st, cfg, client)
				sweepAuditRows(ctx, w, st, cfg, client)
			}
		}
	}()
}

// sweepDeadLinks pushes one link-expired event per link that was never
// used and is past its TTL.
//
// The push is best effort: a brain outage is logged, never fatal, and the
// next sweep reports the same tokens again. Once the brain has them the
// rows go, so a dead link is reported exactly once.
func sweepDeadLinks(ctx context.Context, w io.Writer, st *store.Store, cfg boxagent.BrainConfig, client *http.Client) {
	tokens, err := st.ExpiredLinkTokens(linkSweepBatch)
	if err != nil {
		_, _ = fmt.Fprintln(w, "link sweep failed:", err)
		return
	}
	if len(tokens) == 0 {
		return
	}
	events := make([]boxagent.Event, 0, len(tokens))
	for _, tok := range tokens {
		events = append(events, boxagent.Event{Type: "link-expired", Token: tok})
	}
	pushCtx, cancel := context.WithTimeout(ctx, sweepPushTimeout)
	defer cancel()
	if err := boxagent.PushEvents(pushCtx, client, cfg.BrainURL, cfg.BoxID, cfg.Token, events); err != nil {
		// The brain did not get it. Keep the tokens: a brain outage must
		// not lose the report, the next sweep tries again.
		_, _ = fmt.Fprintln(w, "link sweep push failed:", err)
		return
	}
	// The brain has them. A dead link is worth nothing to anyone else —
	// the claim path refuses it on its TTL — so the rows go and no sweep
	// reports the same dead link again.
	if err := st.DeleteLinkTokens(tokens); err != nil {
		_, _ = fmt.Fprintln(w, "link sweep delete failed:", err)
	}
}

// auditPushFrom returns the rowid the audit push continues after.
//
// The watermark is the rowid of the last audit row the brain has. A
// watermark past the trail's last row is stale: the trail was reset and
// its rowids started over, so the watermark points past every row that
// follows and the push would be silent for good. The watermark is
// repaired then — it goes back to the start of the trail — and the
// trail's rows are offered again. The brain's dedup collapses the rows
// it already has.
func auditPushFrom(w io.Writer, st *store.Store) (int64, error) {
	watermark, err := st.AuditWatermark()
	if err != nil {
		return 0, err
	}
	last, err := st.LastAuditRowID()
	if err != nil {
		return 0, err
	}
	if watermark <= last {
		return watermark, nil
	}
	_, _ = fmt.Fprintln(w, "audit trail was reset: the watermark is repaired")
	if err := st.RepairAuditWatermark(); err != nil {
		return 0, err
	}
	return 0, nil
}

// sweepAuditRows pushes the audit rows the brain has not seen yet: the
// box's own record of what happened. The watermark says how far the box
// got, and it moves only after a successful push: a failed push leaves it
// where it was, so the next sweep offers the same rows again and no row
// is lost.
//
// The push is best effort, like the dead-link push: a brain outage is
// logged, never fatal.
func sweepAuditRows(ctx context.Context, w io.Writer, st *store.Store, cfg boxagent.BrainConfig, client *http.Client) {
	watermark, err := auditPushFrom(w, st)
	if err != nil {
		// The box does not know where it left off. Pushing anyway would
		// re-offer rows the brain already has and move the watermark
		// backwards, so this sweep skips and the next one tries again.
		_, _ = fmt.Fprintln(w, "audit push skipped:", err)
		return
	}
	rows, err := st.RecentAuditSince(watermark)
	if err != nil {
		_, _ = fmt.Fprintln(w, "audit rows read failed:", err)
		return
	}
	if len(rows) == 0 {
		return
	}
	events := make([]boxagent.Event, 0, len(rows))
	for _, row := range rows {
		events = append(events, boxagent.Event{
			Type:   "audit",
			At:     row.At,
			Actor:  row.Actor,
			Action: row.Action,
			Device: row.Device,
			IP:     row.IP,
			Result: row.Result,
			UA:     row.UA,
		})
	}
	pushCtx, cancel := context.WithTimeout(ctx, sweepPushTimeout)
	defer cancel()
	if err := boxagent.PushEvents(pushCtx, client, cfg.BrainURL, cfg.BoxID, cfg.Token, events); err != nil {
		// The brain did not get them. The watermark stays: the next sweep
		// offers the same rows again.
		_, _ = fmt.Fprintln(w, "audit push failed:", err)
		return
	}
	// The brain has them: the watermark moves to the last row sent, so no
	// sweep offers them again.
	if err := st.SetAuditWatermark(rows[len(rows)-1].RowID); err != nil {
		_, _ = fmt.Fprintln(w, "audit watermark write failed:", err)
	}
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
	startSweep(ctx, w, st, sweepInterval)

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
			},
			func(fromID, chatID int64, chatType, data string) {
				tg.DispatchCallback(ctx, st, fromID, chatID, chatType, data)
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
