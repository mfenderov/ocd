package tg

// Fleet bot commands mirror the fleet API for Telegram-first ops: status,
// per-box tap links, per-box revoke, revoke-all, and audit. All builders
// are pure text in, text out (HTML-escaped); the thin Telegram senders live
// in handleText. Auth is the link+revoke+audit CLI token in OCD_FLEET_TOKEN
// (see internal/fleet); an unset token is a state ("fleet off"), never an
// error. Destructive commands need an explicit YES, mirroring /revoke.

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/mfenderov/ocd/internal/boxagent"
	"github.com/mfenderov/ocd/internal/fleet"
	"github.com/mfenderov/ocd/internal/onboard"
	"github.com/mfenderov/ocd/internal/store"
)

// fleetOff is the reply when the box has no fleet token configured.
const fleetOff = "📡 fleet off (OCD_FLEET_TOKEN unset)"

// FleetStatusText renders every enrolled box with inferred state.
func FleetStatusText(ctx context.Context) (string, error) {
	if os.Getenv("OCD_FLEET_TOKEN") == "" {
		return fleetOff, nil
	}
	c, err := fleet.NewClientFromEnv()
	if err != nil {
		return "", err
	}
	backs, err := c.Backends(ctx)
	if err != nil {
		return "", err
	}
	if len(backs) == 0 {
		return "📭 <b>No boxes enrolled.</b>", nil
	}
	now := time.Now()
	var sb strings.Builder
	_, _ = fmt.Fprintf(&sb, "🖥 <b>Fleet</b> (%d)\n", len(backs))
	for _, b := range backs {
		var dot, state string
		switch fleet.BoxState(b, now) {
		case "tombstoned":
			dot, state = "🟠", "tombstoned"
		case "offline":
			dot, state = "🔴", "offline"
		default:
			dot, state = "🟢", "ok"
		}
		_, _ = fmt.Fprintf(&sb, "%s <code>%s</code> · %s · synced %s · epoch %d\n",
			dot, esc(b.ID), state, esc(store.FmtAgo(now.Unix()-b.LastSeen)), b.Epoch)
	}
	return sb.String(), nil
}

// FleetLinkText mints a tap URL for one box. The URL is single-use; it
// travels as a link target, never as visible text.
func FleetLinkText(ctx context.Context, box string) (string, error) {
	if os.Getenv("OCD_FLEET_TOKEN") == "" {
		return fleetOff, nil
	}
	if strings.TrimSpace(box) == "" {
		return "Usage: <code>/flink &lt;box&gt;</code>", nil
	}
	c, err := fleet.NewClientFromEnv()
	if err != nil {
		return "", err
	}
	link, err := c.Link(ctx, box)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("🔑 <a href=\"%s\">Tap to log in to <code>%s</code></a>", esc(link), esc(box)), nil
}

// FleetRevokeText revokes one box once confirmed with YES.
func FleetRevokeText(ctx context.Context, box string, confirmed bool) (string, error) {
	if os.Getenv("OCD_FLEET_TOKEN") == "" {
		return fleetOff, nil
	}
	if strings.TrimSpace(box) == "" {
		return "Usage: <code>/frevoke &lt;box&gt; YES</code>", nil
	}
	if !confirmed {
		return fmt.Sprintf("☠️ <b>Revoke box %s?</b> Its credentials rotate.\nConfirm: <code>/frevoke %s YES</code>",
			esc(box), esc(box)), nil
	}
	c, err := fleet.NewClientFromEnv()
	if err != nil {
		return "", err
	}
	res, err := c.Revoke(ctx, box)
	if err != nil {
		return "", err
	}
	switch res.Status {
	case "revoked":
		return fmt.Sprintf("💀 <code>%s</code> revoked at epoch %d.", esc(box), res.Epoch), nil
	case "tombstoned":
		msg := fmt.Sprintf("⛔ <code>%s</code> blocked at epoch %d — no new links until it returns.", esc(box), res.Epoch)
		if res.Detail != "" {
			msg += "\n<i>" + esc(res.Detail) + "</i>"
		}
		return msg, nil
	default:
		return fmt.Sprintf("⚠️ revoke: %s", esc(res.Status)), nil
	}
}

// FleetNukeText revokes every box once confirmed with YES.
func FleetNukeText(ctx context.Context, confirmed bool) (string, error) {
	if os.Getenv("OCD_FLEET_TOKEN") == "" {
		return fleetOff, nil
	}
	if !confirmed {
		return "☠️ <b>Nuke the whole fleet?</b> Every box re-enrolls.\nConfirm: <code>/fnuke YES</code>", nil
	}
	c, err := fleet.NewClientFromEnv()
	if err != nil {
		return "", err
	}
	results, err := c.RevokeAll(ctx)
	if err != nil {
		return "", err
	}
	var revoked, blocked int
	var sb strings.Builder
	for _, r := range results {
		switch r.Status {
		case "revoked":
			revoked++
		case "tombstoned":
			blocked++
		}
		line := fmt.Sprintf("• <code>%s</code>: %s", esc(r.ID), esc(r.Status))
		if r.Detail != "" {
			line += " — " + esc(r.Detail)
		}
		_, _ = fmt.Fprintln(&sb, line)
	}
	return fmt.Sprintf("💀 nuke: %d revoked, %d blocked\n%s", revoked, blocked, sb.String()), nil
}

// FleetEnrollCodeText issues a single-use enroll code for a new box.
// The code is displayed in the owner-only chat (that display IS the
// approval); the new box pastes the command this returns and is enrolled
// with no approve tap. Default hostname follows the oc-<box> tunnel
// convention; pass an explicit one to override.
func FleetEnrollCodeText(ctx context.Context, box, hostname string) (string, error) {
	if os.Getenv("OCD_FLEET_TOKEN") == "" {
		return fleetOff, nil
	}
	if err := onboard.ValidateBoxID(box); err != nil {
		return "Usage: <code>/enrollcode &lt;box&gt; [hostname]</code>", nil
	}
	if strings.TrimSpace(hostname) == "" {
		hostname = "oc-tap-" + box + ".buyallmemes.com"
	} else if strings.ContainsAny(strings.TrimSpace(hostname), " /:") {
		return "Usage: <code>/enrollcode &lt;box&gt; [hostname]</code>", nil
	} else {
		hostname = strings.TrimSpace(hostname)
	}
	code, err := onboard.GenerateSecret()
	if err != nil {
		return "", err
	}
	client := &http.Client{Timeout: 15 * time.Second}
	status, trusted, err := boxagent.EnrollBoxTrusted(ctx, client, os.Getenv("OCD_WORKER_URL"), box, hostname, code, "", boxagent.EnrollOptions{
		Quiet:  true,
		Bearer: os.Getenv("OCD_FLEET_TOKEN"),
	})
	if err != nil {
		return "", err
	}
	if status != "pending" {
		return fmt.Sprintf("📋 <code>%s</code> is already enrolled.", esc(box)), nil
	}
	if !trusted {
		return fmt.Sprintf("⚠️ Could not issue a code for <code>%s</code>: this bot's fleet token lacks the <code>enroll</code> scope.\nRe-mint it with scopes link, revoke, audit, enroll.", esc(box)), nil
	}
	return fmt.Sprintf("🔑 Enroll code for <code>%s</code> (15 min, single use):\n\n<code>%s</code>\n\nPaste it into a terminal on that machine — it enrolls itself.",
		esc(box), esc(onboard.EnrollCommand(box, code))), nil
}

// FleetAuditText renders recent fleet audit rows, optionally for one box.
func FleetAuditText(ctx context.Context, box string, n int) (string, error) {
	if os.Getenv("OCD_FLEET_TOKEN") == "" {
		return fleetOff, nil
	}
	if n <= 0 {
		n = 10
	}
	if n > 30 {
		n = 30
	}
	c, err := fleet.NewClientFromEnv()
	if err != nil {
		return "", err
	}
	rows, err := c.Audit(ctx, strings.TrimSpace(box), n)
	if err != nil {
		return "", err
	}
	if len(rows) == 0 {
		return "📭 <b>No audit rows.</b>", nil
	}
	var sb strings.Builder
	_, _ = fmt.Fprintf(&sb, "📋 <b>Audit</b> (%d)\n", len(rows))
	for _, r := range rows {
		if r.IsError() {
			_, _ = fmt.Fprintf(&sb, "• <code>%s</code> · error: %s\n", esc(r.Box), esc(r.Detail))
			continue
		}
		at := time.Unix(r.At, 0).UTC().Format("Jan 2 15:04")
		_, _ = fmt.Fprintf(&sb, "• %s · %s @ <code>%s</code>\n  <i>%s · %s · %s %s</i>\n",
			esc(r.Action), esc(r.Actor), esc(r.Box), esc(at), esc(r.Result), esc(r.Device), esc(r.IP))
		if r.Tainted {
			_, _ = fmt.Fprintf(&sb, "  ⚠️ revoke pending\n")
		}
	}
	return sb.String(), nil
}
