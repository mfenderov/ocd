package tg

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"

	"github.com/mfenderov/ocd/internal/admin"
	"github.com/mfenderov/ocd/internal/pair"
	"github.com/mfenderov/ocd/internal/store"
)

func ownerID() int64 {
	id, _ := strconv.ParseInt(os.Getenv("OCD_OWNER_ID"), 10, 64)
	return id
}

func publicBase() string {
	if u := os.Getenv("OCD_PUBLIC_URL"); u != "" {
		return u
	}
	return "https://oc-tap.buyallmemes.com/pair"
}

// HandleLogin is the pure decision core: empty string means silent drop.
func HandleLogin(senderID int64, text string, owner int64) string {
	if senderID != owner || owner == 0 {
		return ""
	}
	fields := strings.Fields(text)
	device := ""
	if len(fields) > 1 {
		device = fields[1]
	}
	if device == "" {
		device = "oneshot"
	}
	return "mint:" + device
}

func esc(s string) string {
	r := strings.ReplaceAll(s, "&", "&amp;")
	r = strings.ReplaceAll(r, "<", "&lt;")
	r = strings.ReplaceAll(r, ">", "&gt;")
	return r
}

func sendProxyLink(ctx context.Context, b *bot.Bot, chatID int64, st *store.Store, device string) {
	// Links stay unbound: the tapping client identifies itself at tap time.
	// Entry names are only a manual checklist in /devices, never auto-attached.
	tok, err := st.IssueLink(device, "telegram")
	if err != nil {
		st.Audit("tg:owner", "link_failed", device, "", err.Error())
		_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: chatID, ParseMode: "HTML", Text: "⚠️ <b>Couldn't issue a link</b> — try again in a moment."})
		return
	}
	st.Audit("tg:owner", "link_issued", device, "", "ok")
	previewOff := true
	sent, err := b.SendMessage(ctx, &bot.SendMessageParams{
		ChatID:             chatID,
		ParseMode:          "HTML",
		Text:               "🔑 <b>Tap to log in</b>\none tap · expires in 10 min\n" + publicBase() + "?t=" + tok,
		LinkPreviewOptions: &models.LinkPreviewOptions{IsDisabled: &previewOff},
	})
	if err == nil {
		_ = st.SetLinkMessage(tok, chatID, sent.ID)
	}
}

func sendDevices(ctx context.Context, b *bot.Bot, chatID int64, st *store.Store) {
	names := st.ListDevices()
	if len(names) == 0 {
		_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: chatID, ParseMode: "HTML", Text: "📭 <b>No devices yet.</b>"})
		return
	}
	var sb strings.Builder
	sb.WriteString("📱 <b>Devices</b>\n")
	now := time.Now().Unix()
	for _, n := range names {
		d, _ := st.GetDevice(n)
		left := d.ExpiresAt - now
		state := "expired"
		if left > 0 {
			state = fmt.Sprintf("%dd %dh left", left/86400, (left%86400)/3600)
		}
		taps, last := st.TapStats(n, 7*24*time.Hour)
		fmt.Fprintf(&sb, "• <code>%s</code> %s — %s\n  %d taps/7d · last %s\n", esc(d.Name), esc(d.Platform), state, taps, store.FmtAgo(last))
	}
	_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: chatID, ParseMode: "HTML", Text: sb.String()})
}

func sendAudit(ctx context.Context, b *bot.Bot, chatID int64, st *store.Store) {
	rows := st.RecentAudit(15)
	if len(rows) == 0 {
		_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: chatID, ParseMode: "HTML", Text: "📭 <b>Trail is empty.</b>"})
		return
	}
	var sb strings.Builder
	sb.WriteString("🧾 <b>Trail</b> · last 15\n")
	for _, r := range rows {
		ts := time.Unix(r.At, 0).Format("15:04:05")
		fmt.Fprintf(&sb, "<code>%s</code> %s <code>%s</code> %s\n", ts, esc(r.Action), esc(r.Device), esc(r.Result))
		if r.UA != "" {
			fmt.Fprintf(&sb, "<code>%s</code>\n", esc(r.UA))
		}
	}
	_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: chatID, ParseMode: "HTML", Text: sb.String()})
}

func realExec(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).Output()
	return string(out), err
}

func Start(ctx context.Context, st *store.Store) error {
	token := os.Getenv("OCD_TG_TOKEN")
	if token == "" {
		return nil
	}
	owner := ownerID()
	b, err := bot.New(token)
	if err != nil {
		return err
	}
	gate := func(update *models.Update) (int64, bool) {
		if update.Message == nil {
			return 0, false
		}
		if update.Message.Chat.Type != "private" {
			st.Audit("tg:stranger", "group_denied", "", "", string(update.Message.Chat.Type))
			return 0, false
		}
		if update.Message.From.ID != owner || owner == 0 {
			st.Audit("tg:stranger", "stranger_denied", "", "", update.Message.Text)
			return 0, false
		}
		return update.Message.Chat.ID, true
	}
	b.RegisterHandler(bot.HandlerTypeMessageText, "/login", bot.MatchTypePrefix,
		func(ctx context.Context, b *bot.Bot, update *models.Update) {
			chatID, ok := gate(update)
			if !ok {
				return
			}
			reply := HandleLogin(update.Message.From.ID, update.Message.Text, owner)
			if reply == "" {
				return
			}
			sendProxyLink(ctx, b, chatID, st, strings.TrimPrefix(reply, "mint:"))
		})
	b.RegisterHandler(bot.HandlerTypeMessageText, "/devices", bot.MatchTypeExact,
		func(ctx context.Context, b *bot.Bot, update *models.Update) {
			chatID, ok := gate(update)
			if !ok {
				return
			}
			sendDevices(ctx, b, chatID, st)
		})
	b.RegisterHandler(bot.HandlerTypeMessageText, "/audit", bot.MatchTypeExact,
		func(ctx context.Context, b *bot.Bot, update *models.Update) {
			chatID, ok := gate(update)
			if !ok {
				return
			}
			sendAudit(ctx, b, chatID, st)
		})
	b.RegisterHandler(bot.HandlerTypeMessageText, "/status", bot.MatchTypeExact,
		func(ctx context.Context, b *bot.Bot, update *models.Update) {
			chatID, ok := gate(update)
			if !ok {
				return
			}
			_, _ = b.SendMessage(ctx, &bot.SendMessageParams{
				ChatID:    chatID,
				ParseMode: "HTML",
				Text:      admin.StatusHTML(st, realExec),
			})
		})
	b.RegisterHandler(bot.HandlerTypeMessageText, "/revoke", bot.MatchTypePrefix,
		func(ctx context.Context, b *bot.Bot, update *models.Update) {
			chatID, ok := gate(update)
			if !ok {
				return
			}
			if !strings.HasSuffix(update.Message.Text, " YES") {
				_, _ = b.SendMessage(ctx, &bot.SendMessageParams{
					ChatID:    chatID,
					ParseMode: "HTML",
					Text:      "☠️ <b>Kills every session everywhere</b>, including yours.\nConfirm: <code>/revoke YES</code>",
				})
				return
			}
			if err := admin.Revoke(st, realExec); err != nil {
				st.Audit("tg:owner", "revoke_failed", "", "", err.Error())
				_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: chatID, ParseMode: "HTML", Text: "⚠️ <b>Revoke failed:</b> " + esc(err.Error())})
				return
			}
			_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: chatID, ParseMode: "HTML", Text: "💀 <b>All sessions dead.</b>\n<code>/login</code> fresh on each device."})
		})
	// Sweeper rewrites spent link messages so chat history stays clean
	// and holds no live links.
	go func() {
		tick := time.NewTicker(30 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				for _, p := range st.PendingEdits() {
					text := "⌛️ <b>Expired</b> · never tapped\n/login for a fresh one"
					if p.Note == "used" {
						when := time.Unix(p.UsedAt, 0).Format("15:04:05")
						var sb strings.Builder
						fmt.Fprintf(&sb, "✅ <b>Logged in · %s</b>\n<code>%s · %s</code>", esc(pair.DeviceHint(p.UsedUA)), esc(when), esc(p.UsedIP))
						if ua := strings.TrimSpace(p.UsedUA); ua != "" {
							fmt.Fprintf(&sb, "\n<code>%s</code>", esc(ua))
						}
						text = sb.String()
					}
					_, editErr := b.EditMessageText(ctx, &bot.EditMessageTextParams{
						ChatID:    p.ChatID,
						MessageID: p.MessageID,
						ParseMode: "HTML",
						Text:      text,
					})
					if editErr != nil {
						st.Audit("tg:owner", "edit_failed", p.Device, "", editErr.Error())
						continue
					}
					st.MarkEdited(p.Token)
				}
			}
		}
	}()
	b.Start(ctx)
	return nil
}
