package tg

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"

	"github.com/mfenderov/ocd/internal/mint"
	"github.com/mfenderov/ocd/internal/store"
)

func ownerID() int64 {
	id, _ := strconv.ParseInt(os.Getenv("OCD_OWNER_ID"), 10, 64)
	return id
}

func pairURL() string {
	if u := os.Getenv("OCD_PAIR_URL"); u != "" {
		return u
	}
	return "https://oc.buyallmemes.com"
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

func execPair() (string, error) {
	out, err := exec.Command("opencode", "pair", "--url", pairURL()).Output()
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
	b.RegisterHandler(bot.HandlerTypeMessageText, "/login", bot.MatchTypePrefix,
		func(ctx context.Context, b *bot.Bot, update *models.Update) {
			if update.Message == nil {
				return
			}
			reply := HandleLogin(update.Message.From.ID, update.Message.Text, owner)
			if reply == "" {
				return
			}
			device := strings.TrimPrefix(reply, "mint:")
			if device == "oneshot" {
				if names := st.ListDevices(); len(names) == 1 {
					device = names[0]
				}
			}
			link, err := mint.Mint(st, execPair, device, "telegram")
			msg := link
			noPreview := true
			if err != nil {
				if err == mint.ErrRateLimited {
					msg = "wait a bit before next link"
				} else {
					msg = "mint failed on this box (no opencode here yet)"
				}
			}
			_, _ = b.SendMessage(ctx, &bot.SendMessageParams{
				ChatID: update.Message.Chat.ID,
				Text:   msg,
				// Pair links die on first open: a Telegram link preview
				// fetch would spend the code before the owner copies it.
				LinkPreviewOptions: &models.LinkPreviewOptions{IsDisabled: &noPreview},
			})
		})
	b.Start(ctx)
	return nil
}
