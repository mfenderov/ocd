package tg

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"

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
	return "https://oc.buyallmemes.com/pair"
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

func resolveDevice(st *store.Store, device string) string {
	if device == "oneshot" {
		if names := st.ListDevices(); len(names) == 1 {
			return names[0]
		}
	}
	return device
}

func sendProxyLink(ctx context.Context, b *bot.Bot, chatID int64, st *store.Store, device string) {
	device = resolveDevice(st, device)
	tok, err := st.IssueLink(device, "telegram")
	if err != nil {
		st.Audit("tg:owner", "link_failed", device, "", err.Error())
		_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: chatID, Text: "could not issue link"})
		return
	}
	st.Audit("tg:owner", "link_issued", device, "", "ok")
	previewOff := true
	_, _ = b.SendMessage(ctx, &bot.SendMessageParams{
		ChatID:             chatID,
		Text:               "tap to log in (" + device + ", one tap, 10 min):\n" + publicBase() + "?t=" + tok,
		LinkPreviewOptions: &models.LinkPreviewOptions{IsDisabled: &previewOff},
	})
}

func sendDevices(ctx context.Context, b *bot.Bot, chatID int64, st *store.Store) {
	names := st.ListDevices()
	if len(names) == 0 {
		_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: chatID, Text: "no devices yet"})
		return
	}
	var sb strings.Builder
	now := time.Now().Unix()
	for _, n := range names {
		d, _ := st.GetDevice(n)
		left := d.ExpiresAt - now
		state := "EXPIRED"
		if left > 0 {
			state = fmt.Sprintf("%dd %dh left", left/86400, (left%86400)/3600)
		}
		fmt.Fprintf(&sb, "%s (%s): %s\n", d.Name, d.Platform, state)
	}
	_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: chatID, Text: sb.String()})
}

func sendAudit(ctx context.Context, b *bot.Bot, chatID int64, st *store.Store) {
	rows := st.RecentAudit(15)
	if len(rows) == 0 {
		_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: chatID, Text: "audit empty"})
		return
	}
	var sb strings.Builder
	for _, r := range rows {
		ts := time.Unix(r.At, 0).Format("15:04:05")
		fmt.Fprintf(&sb, "%s %s %s %s\n", ts, r.Action, r.Device, r.Result)
	}
	_, _ = b.SendMessage(ctx, &bot.SendMessageParams{ChatID: chatID, Text: sb.String()})
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
	b.Start(ctx)
	return nil
}
