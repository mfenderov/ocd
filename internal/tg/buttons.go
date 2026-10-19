package tg

// Button-driven fleet UI. Telegram inline keyboards turn every action
// into one tap: /fleet lists boxes as buttons, tapping one mints a link
// for that box, and the reply carries an "Open" URL button.
//
// Link-bearing replies always go to the owner's DM. A tap link is a
// credential, so it must not be posted where other group members can see
// it; the chat that asked gets a pointer to the DM instead.

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"
	"github.com/mfenderov/ocd/internal/fleet"
	"github.com/mfenderov/ocd/internal/store"
)

// callbackFlink is the callback data prefix for "mint a link for a box".
const callbackFlink = "flink:"

// boxKey caps the button label length Telegram renders well.
const boxKey = 32

// boxButton builds one inline button per box, labeled with its live state.
func boxButton(boxes []fleet.Backend, now time.Time) [][]models.InlineKeyboardButton {
	if len(boxes) == 0 {
		return nil
	}
	row := make([]models.InlineKeyboardButton, 0, len(boxes))
	for _, b := range boxes {
		label := "⚪ " + b.ID
		switch fleet.BoxState(b, now) {
		case "ok":
			label = "🟢 " + b.ID
		case "offline":
			label = "🔴 " + b.ID
		case "tombstoned":
			label = "🟠 " + b.ID
		}
		if len(label) > boxKey {
			label = label[:boxKey]
		}
		row = append(row, models.InlineKeyboardButton{
			Text:         label,
			CallbackData: callbackFlink + b.ID,
		})
	}
	return [][]models.InlineKeyboardButton{row}
}

// openButton is the URL button that opens a minted link.
func openButton(text, url string) models.InlineKeyboardMarkup {
	return models.InlineKeyboardMarkup{
		InlineKeyboard: [][]models.InlineKeyboardButton{{{Text: text, URL: url}}},
	}
}

// sendDM delivers a message to the owner's private chat. Telegram's
// private chat id equals the user id, so the owner id is the DM target.
func sendDM(ctx context.Context, b *bot.Bot, owner int64, text string, markup models.ReplyMarkup) {
	if owner == 0 {
		return
	}
	_, _ = b.SendMessage(ctx, &bot.SendMessageParams{
		ChatID:      owner,
		ParseMode:   "HTML",
		Text:        text,
		ReplyMarkup: markup,
	})
}

// sendDMOrChat delivers to the owner's DM, and points the asking chat
// there when it is not the DM. Nothing secret is echoed into a group.
func sendDMOrChat(ctx context.Context, b *bot.Bot, st *store.Store, owner, chatID int64, chatType, text string, markup models.ReplyMarkup) {
	sendDM(ctx, b, owner, text, markup)
	if chatID != 0 && chatID != owner {
		_, _ = b.SendMessage(ctx, &bot.SendMessageParams{
			ChatID:    chatID,
			ParseMode: "HTML",
			Text:      "🔔 Sent to your DM.",
		})
	}
}

// handleCallback processes one inline-button tap: "flink:<box>" mints a
// link for that box and posts it as a button in the owner's DM.
func handleCallback(ctx context.Context, b *bot.Bot, st *store.Store, owner, fromID, chatID int64, chatType, data string) {
	if !AllowedChat(models.ChatType(chatType), chatID, allowedGroupID()) {
		st.Audit("tg:stranger", "group_denied", "", "", chatType)
		return
	}
	if !IsOwner(fromID, owner) {
		st.Audit("tg:stranger", "stranger_denied", "", "", data)
		return
	}
	if !strings.HasPrefix(data, callbackFlink) {
		return
	}
	box := strings.TrimSpace(strings.TrimPrefix(data, callbackFlink))
	if box == "" {
		return
	}
	link, err := mintBoxLink(ctx, box)
	if err != nil {
		st.Audit("tg:owner", "link_failed", box, "", err.Error())
		sendDM(ctx, b, owner, "⚠️ <b>Link failed:</b> "+esc(err.Error()), nil)
		return
	}
	st.Audit("tg:owner", "link_issued", box, "", "button")
	sendDM(ctx, b, owner, fmt.Sprintf("🔗 <b>%s</b> ready — one tap:", esc(box)), openButton("🚀 Open "+box, link))
}

// mintBoxLink mints a tap link for one box through the fleet API. The
// worker relays to the box, so this works for every box in the fleet.
func mintBoxLink(ctx context.Context, box string) (string, error) {
	c, err := fleet.NewClientFromEnv()
	if err != nil {
		return "", err
	}
	return c.Link(ctx, box)
}

// sendFleetBoard posts the fleet list with one button per box. The board
// goes to the owner's DM (buttons can be tapped from anywhere, and the
// group only learns that something happened).
func sendFleetBoard(ctx context.Context, b *bot.Bot, st *store.Store, owner, chatID int64, chatType string) {
	text, boxes, err := fleetBoard()
	if err != nil {
		st.Audit("tg:owner", "fleet_failed", "", "", err.Error())
		sendDMOrChat(ctx, b, st, owner, chatID, chatType, "⚠️ <b>Fleet failed:</b> "+esc(err.Error()), nil)
		return
	}
	sendDMOrChat(ctx, b, st, owner, chatID, chatType, text, models.InlineKeyboardMarkup{InlineKeyboard: boxButton(boxes, time.Now())})
}

// fleetBoard renders the fleet text plus the box rows for the buttons.
func fleetBoard() (string, []fleet.Backend, error) {
	c, err := fleet.NewClientFromEnv()
	if err != nil {
		return "", nil, err
	}
	boxes, err := c.Backends(context.Background())
	if err != nil {
		return "", nil, err
	}
	if len(boxes) == 0 {
		return "📭 <b>No boxes enrolled.</b>", nil, nil
	}
	now := time.Now()
	var sb strings.Builder
	_, _ = fmt.Fprintf(&sb, "🖥 <b>Fleet</b> (%d)\n", len(boxes))
	for _, b := range boxes {
		var dot string
		switch fleet.BoxState(b, now) {
		case "ok":
			dot = "🟢"
		case "offline":
			dot = "🔴"
		default:
			dot = "🟠"
		}
		_, _ = fmt.Fprintf(&sb, "%s <code>%s</code> · %s · synced %s\n",
			dot, esc(b.ID), esc(fleet.BoxState(b, now)), esc(store.FmtAgo(now.Unix()-b.LastSeen)))
	}
	return sb.String(), boxes, nil
}

// DispatchCallback handles one inline-button tap delivered by webhook.
func DispatchCallback(ctx context.Context, st *store.Store, fromID, chatID int64, chatType, data string) {
	owner := ownerID()
	b, err := senderBot()
	if err != nil {
		st.Audit("tg:owner", "dispatch_failed", "", "", err.Error())
		return
	}
	handleCallback(ctx, b, st, owner, fromID, chatID, chatType, data)
}
