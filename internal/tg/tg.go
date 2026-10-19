package tg

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"

	"github.com/mfenderov/ocd/internal/admin"
	"github.com/mfenderov/ocd/internal/store"
)

// sender is the shared push client for webhook-delivered replies.
// The poller owns its own instance; this one only sends, never polls,
// so both modes can coexist in one process.
var (
	senderMu sync.Mutex
	sender   *bot.Bot
)

func senderBot() (*bot.Bot, error) {
	senderMu.Lock()
	defer senderMu.Unlock()
	if sender != nil {
		return sender, nil
	}
	token := os.Getenv("OCD_TG_TOKEN")
	if token == "" {
		return nil, fmt.Errorf("no token")
	}
	b, err := bot.New(token)
	if err != nil {
		return nil, err
	}
	sender = b
	return sender, nil
}

func ownerID() int64 {
	id, _ := strconv.ParseInt(os.Getenv("OCD_OWNER_ID"), 10, 64)
	return id
}

// allowedGroupID is the shared owner-only group where every box bot may
// answer addressed commands. Zero means no group is allowed.
func allowedGroupID() int64 {
	id, _ := strconv.ParseInt(os.Getenv("OCD_GROUP_ID"), 10, 64)
	return id
}

func botName() string {
	return os.Getenv("OCD_BOT_NAME")
}

// AllowedChat reports whether chatID may talk to this bot: DMs always,
// groups only when they are the configured shared group.
func AllowedChat(chatType models.ChatType, chatID, groupID int64) bool {
	if chatType == "private" {
		return true
	}
	if chatType != "group" && chatType != "supergroup" {
		return false
	}
	return groupID != 0 && chatID == groupID
}

// IsOwner is the single ownership predicate shared by every entry point.
func IsOwner(fromID, owner int64) bool {
	return owner != 0 && fromID == owner
}

// NormalizeCommand strips an @botsuffix and enforces addressing: in a
// group a command must name this bot (bare commands would fire every
// bot in the shared group); in DMs bare commands pass through.
func NormalizeCommand(text, name string, isGroup bool) (string, bool) {
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return "", false
	}
	cmd := fields[0]
	if i := strings.Index(cmd, "@"); i >= 0 {
		if name == "" || cmd[i+1:] != name {
			return "", false
		}
		cmd = cmd[:i]
	} else if isGroup {
		return "", false
	}
	return strings.Join(append([]string{cmd}, fields[1:]...), " "), true
}

func publicBase() string {
	if u := os.Getenv("OCD_PUBLIC_URL"); u != "" {
		return u
	}
	return "https://oc-tap.buyallmemes.com/pair"
}

// HandleLogin is the pure decision core: empty string means silent drop.
func HandleLogin(senderID int64, text string, owner int64) string {
	if !IsOwner(senderID, owner) {
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

func sendProxyLink(ctx context.Context, b *bot.Bot, owner, chatID int64, chatType string, st *store.Store, device string) {
	tok, err := st.IssueLink(device, "telegram")
	if err != nil {
		st.Audit("tg:owner", "link_failed", device, "", err.Error())
		sendDMOrChat(ctx, b, st, owner, chatID, chatType, "⚠️ <b>Couldn't issue a link</b> — try again in a moment.", nil)
		return
	}
	st.Audit("tg:owner", "link_issued", device, "", "ok")
	link := publicBase() + "?t=" + tok
	previewOff := true
	sent, err := b.SendMessage(ctx, &bot.SendMessageParams{
		ChatID:             owner,
		ParseMode:          "HTML",
		Text:               "🔑 <b>OpenCode ready</b> — one tap · expires in 10 min",
		ReplyMarkup:        openButton("🚀 Open OpenCode", link),
		LinkPreviewOptions: &models.LinkPreviewOptions{IsDisabled: &previewOff},
	})
	if err == nil {
		_ = st.SetLinkMessage(tok, owner, sent.ID)
	}
	if chatID != 0 && chatID != owner {
		_, _ = b.SendMessage(ctx, &bot.SendMessageParams{
			ChatID:    chatID,
			ParseMode: "HTML",
			Text:      "🔔 Sent to your DM.",
		})
	}
}

func sendDevices(ctx context.Context, b *bot.Bot, chatID int64, st *store.Store) {
	clients := st.SeenClients()
	if len(clients) == 0 {
		_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: chatID, ParseMode: "HTML", Text: "📭 <b>No taps yet.</b>"})
		return
	}
	var sb strings.Builder
	sb.WriteString("📱 <b>Seen clients</b>\n")
	for _, c := range clients {
		_, _ = fmt.Fprintf(&sb, "• <code>%s</code> · %d taps · %s\n", esc(c.IP), c.Count, esc(store.FmtAgo(time.Now().Unix()-c.Last)))
		if c.UA != "" {
			_, _ = fmt.Fprintf(&sb, "<code>%s</code>\n", esc(c.UA))
		}
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
		_, _ = fmt.Fprintf(&sb, "<code>%s</code> %s · %s · %s\n", ts, esc(r.Action), esc(r.IP), esc(r.Result))
		if r.UA != "" {
			_, _ = fmt.Fprintf(&sb, "<code>%s</code>\n", esc(r.UA))
		}
	}
	_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: chatID, ParseMode: "HTML", Text: sb.String()})
}

func realExec(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).Output()
	return string(out), err
}

func checkGate(st *store.Store, owner int64, update *models.Update) (int64, bool) {
	if update.Message == nil {
		return 0, false
	}
	if !AllowedChat(update.Message.Chat.Type, update.Message.Chat.ID, allowedGroupID()) {
		st.Audit("tg:stranger", "group_denied", "", "", string(update.Message.Chat.Type))
		return 0, false
	}
	if !IsOwner(update.Message.From.ID, owner) {
		text := update.Message.Text
		if len(text) > 80 {
			text = text[:80]
		}
		st.Audit("tg:stranger", "stranger_denied", "", "", text)
		return 0, false
	}
	return update.Message.Chat.ID, true
}

func handleText(ctx context.Context, b *bot.Bot, st *store.Store, owner int64, chatID int64, chatType string, fromID int64, text string) {
	if !IsOwner(fromID, owner) {
		st.Audit("tg:stranger", "stranger_denied", "", "", "handleText")
		return
	}
	switch {
	case strings.HasPrefix(text, "/link"):
		// /link is the menu: which machine do you want to work in?
		sendFleetBoard(ctx, b, st, owner, chatID, chatType)
	case strings.HasPrefix(text, "/login"):
		reply := HandleLogin(fromID, text, owner)
		if reply == "" {
			return
		}
		sendProxyLink(ctx, b, owner, chatID, chatType, st, strings.TrimPrefix(reply, "mint:"))
	case text == "/devices":
		sendDevices(ctx, b, chatID, st)
	case text == "/audit":
		sendAudit(ctx, b, chatID, st)
	case text == "/status":
		_, _ = b.SendMessage(ctx, &bot.SendMessageParams{
			ChatID:    chatID,
			ParseMode: "HTML",
			Text:      admin.StatusHTML(st, realExec),
		})
	case strings.HasPrefix(text, "/revoke"):
		handleRevoke(ctx, b, st, chatID, text)
	case text == "/fleet":
		sendFleetBoard(ctx, b, st, owner, chatID, chatType)
	case strings.HasPrefix(text, "/flink"):
		box := firstFleetArg(text, "/flink")
		sendFleetReply(ctx, b, st, chatID, box, "link", func() (string, error) {
			return FleetLinkText(ctx, box)
		})
	case strings.HasPrefix(text, "/frevoke"):
		box, confirmed := fleetBoxConfirm(text, "/frevoke")
		sendFleetReply(ctx, b, st, chatID, box, "revoke", func() (string, error) {
			return FleetRevokeText(ctx, box, confirmed)
		})
	case strings.HasPrefix(text, "/fnuke"):
		confirmed := hasFleetYes(text, "/fnuke")
		sendFleetReply(ctx, b, st, chatID, "", "nuke", func() (string, error) {
			return FleetNukeText(ctx, confirmed)
		})
	case strings.HasPrefix(text, "/faudit"):
		box, n := fleetAuditArgs(text, "/faudit")
		sendFleetReply(ctx, b, st, chatID, box, "audit", func() (string, error) {
			return FleetAuditText(ctx, box, n)
		})
	case strings.HasPrefix(text, "/enrollcode"):
		box, host := fleetEnrollArgs(text)
		sendFleetReply(ctx, b, st, chatID, box, "enroll-code", func() (string, error) {
			return FleetEnrollCodeText(ctx, box, host)
		})
	}
}

// sendFleetReply delivers one fleet command result, auditing failures.
func sendFleetReply(ctx context.Context, b *bot.Bot, st *store.Store, chatID int64, box, action string, text func() (string, error)) {
	msg, err := text()
	if err != nil {
		st.Audit("tg:owner", "fleet_failed", box, action, err.Error())
		msg = "⚠️ <b>Fleet failed:</b> " + esc(err.Error())
	}
	_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: chatID, ParseMode: "HTML", Text: msg})
}

// firstFleetArg returns the argument after a bare command (/flink <box>).
func firstFleetArg(text, cmd string) string {
	fields := strings.Fields(text)
	if len(fields) != 2 || fields[0] != cmd {
		return ""
	}
	return fields[1]
}

// fleetBoxConfirm parses /frevoke <box> [YES]: trailing YES confirms.
func fleetBoxConfirm(text, cmd string) (string, bool) {
	fields := strings.Fields(text)
	if len(fields) < 2 || fields[0] != cmd {
		return "", false
	}
	box := fields[1]
	if box == "YES" {
		return "", false
	}
	return box, len(fields) > 2 && fields[len(fields)-1] == "YES"
}

// hasFleetYes reports a trailing YES (/fnuke YES).
func hasFleetYes(text, cmd string) bool {
	fields := strings.Fields(text)
	return len(fields) == 2 && fields[0] == cmd && fields[1] == "YES"
}

// fleetEnrollArgs parses /enrollcode <box> [hostname].
func fleetEnrollArgs(text string) (string, string) {
	fields := strings.Fields(text)
	if len(fields) < 2 || fields[0] != "/enrollcode" {
		return "", ""
	}
	host := ""
	if len(fields) > 2 {
		host = fields[2]
	}
	return fields[1], host
}

// fleetAuditArgs parses /faudit [box] [n]: the numeric argument is the limit.
func fleetAuditArgs(text, cmd string) (string, int) {
	fields := strings.Fields(text)
	if len(fields) == 0 || fields[0] != cmd {
		return "", 0
	}
	box, n := "", 0
	for _, a := range fields[1:] {
		var v int
		if _, err := fmt.Sscanf(a, "%d", &v); err == nil {
			n = v
		} else if box == "" {
			box = a
		}
	}
	return box, n
}

func handleRevoke(ctx context.Context, b *bot.Bot, st *store.Store, chatID int64, text string) {
	if !strings.HasSuffix(text, " YES") {
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
}

// Dispatch handles one webhook-delivered message through the same gate
// and command set as polling. Owner and chat type are re-checked here;
// a bad sender gets the same silent drop plus audit row.
func Dispatch(ctx context.Context, st *store.Store, chatID, fromID int64, chatType, text string) {
	owner := ownerID()
	if !AllowedChat(models.ChatType(chatType), chatID, allowedGroupID()) {
		st.Audit("tg:stranger", "group_denied", "", "", chatType)
		return
	}
	if !IsOwner(fromID, owner) {
		t := text
		if len(t) > 80 {
			t = t[:80]
		}
		st.Audit("tg:stranger", "stranger_denied", "", "", t)
		return
	}
	text, ok := NormalizeCommand(text, botName(), chatType != "private")
	if !ok {
		return
	}
	b, err := senderBot()
	if err != nil {
		st.Audit("tg:owner", "dispatch_failed", "", "", err.Error())
		return
	}
	handleText(ctx, b, st, owner, chatID, chatType, fromID, text)
}

// SetWebhook registers the push URL with Telegram.
func SetWebhook(ctx context.Context, url, secret string) error {
	return setWebhook(ctx, url, secret)
}

// DeleteWebhook drops push delivery; polling keeps working.
func DeleteWebhook(ctx context.Context) error {
	return deleteWebhook(ctx)
}

func Start(ctx context.Context, st *store.Store, poll bool) error {
	token := os.Getenv("OCD_TG_TOKEN")
	if token == "" {
		return nil
	}
	owner := ownerID()
	b, err := bot.New(token)
	if err != nil {
		return err
	}
	// Boot ping: silence is the alarm. Best effort, never blocks startup.
	if owner != 0 {
		_, _ = b.SendMessage(ctx, &bot.SendMessageParams{
			ChatID:    owner,
			ParseMode: "HTML",
			Text:      "🟢 <b>ocd back online.</b>",
		})
	}
	gate := func(update *models.Update) (int64, bool) {
		return checkGate(st, owner, update)
	}
	b.RegisterHandler(bot.HandlerTypeMessageText, "/login", bot.MatchTypePrefix,
		func(ctx context.Context, b *bot.Bot, update *models.Update) {
			chatID, ok := gate(update)
			if !ok {
				return
			}
			text, ok := NormalizeCommand(update.Message.Text, botName(), update.Message.Chat.Type != "private")
			if !ok {
				return
			}
			handleText(ctx, b, st, owner, chatID, string(update.Message.Chat.Type), update.Message.From.ID, text)
		})
	// Inline-button taps (fleet board). Callback queries carry their own
	// chat and sender, so the same owner/chat gate applies.
	b.RegisterHandler(bot.HandlerTypeCallbackQueryData, callbackFlink, bot.MatchTypePrefix,
		func(ctx context.Context, b *bot.Bot, update *models.Update) {
			cq := update.CallbackQuery
			if cq == nil {
				return
			}
			msg := cq.Message.Message
			if msg == nil {
				return
			}
			handleCallback(ctx, b, st, owner, cq.From.ID, msg.Chat.ID, string(msg.Chat.Type), cq.Data)
		})
	// Sweeper rewrites spent link messages so chat history stays clean
	// and holds no live links. Runs in both poll and webhook mode.
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
						_, _ = fmt.Fprintf(&sb, "✅ <b>Logged in</b> · %s\n<code>%s</code>", esc(when), esc(p.UsedIP))
						if ua := strings.TrimSpace(p.UsedUA); ua != "" {
							_, _ = fmt.Fprintf(&sb, "\n<code>%s</code>", esc(ua))
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
	// Polling and push delivery are mutually exclusive server-side:
	// while a webhook is set, getUpdates answers 409. So the poll loop
	// runs only when push is off; the sweeper above runs in both modes.
	if !poll {
		return nil
	}
	b.Start(ctx)
	return nil
}
