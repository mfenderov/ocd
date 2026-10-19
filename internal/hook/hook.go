// Package hook serves Telegram push updates with idempotent processing.
// Secret is checked before any work; replays answer 200 but process once.
package hook

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"

	"github.com/mfenderov/ocd/internal/store"
)

const maxBody = 64 * 1024

// ProcessFunc handles one verified update. Telegram retries on failure,
// so work must be idempotent (dedup by update ID happens before this).
// A callback query (inline-button tap) arrives with text == "" and the
// callback data instead.
type ProcessFunc func(chatID, fromID int64, chatType, text string)

// CallbackFunc handles one inline-button tap.
type CallbackFunc func(fromID, chatID int64, chatType, data string)

func Handler(st *store.Store, secret string, seen func(updateID int64) bool, process ProcessFunc, callback CallbackFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		got := r.Header.Get("X-Telegram-Bot-Api-Secret-Token")
		if subtle.ConstantTimeCompare([]byte(got), []byte(secret)) != 1 || secret == "" {
			st.Audit("tg:hook", "hook_denied", "", clientIP(r), "bad-secret")
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
		if err != nil {
			http.Error(w, "too big", http.StatusRequestEntityTooLarge)
			return
		}
		type chatRef struct {
			ID   int64  `json:"id"`
			Type string `json:"type"`
		}
		type userRef struct {
			ID int64 `json:"id"`
		}
		var u struct {
			UpdateID int64 `json:"update_id"`
			Message  *struct {
				MessageID int      `json:"message_id"`
				Chat      *chatRef `json:"chat"`
				From      *userRef `json:"from"`
				Text      string   `json:"text"`
			} `json:"message"`
			CallbackQuery *struct {
				Data    string   `json:"data"`
				From    *userRef `json:"from"`
				Message *struct {
					Chat *chatRef `json:"chat"`
				} `json:"message"`
			} `json:"callback_query"`
		}
		if err := json.Unmarshal(body, &u); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		if seen != nil && seen(u.UpdateID) {
			w.WriteHeader(http.StatusOK)
			return
		}
		var chatID, fromID int64
		var chatType, text string
		if u.Message != nil {
			text = u.Message.Text
			if u.Message.Chat != nil {
				chatID, chatType = u.Message.Chat.ID, u.Message.Chat.Type
			}
			if u.Message.From != nil {
				fromID = u.Message.From.ID
			}
		}
		// An inline-button tap carries no message text: it comes as a
		// callback_query and must reach the bot's button handler.
		if u.CallbackQuery != nil && callback != nil {
			cbChatID, cbChatType := int64(0), ""
			if u.CallbackQuery.Message != nil && u.CallbackQuery.Message.Chat != nil {
				cbChatID, cbChatType = u.CallbackQuery.Message.Chat.ID, u.CallbackQuery.Message.Chat.Type
			}
			cbFromID := int64(0)
			if u.CallbackQuery.From != nil {
				cbFromID = u.CallbackQuery.From.ID
			}
			data := u.CallbackQuery.Data
			go callback(cbFromID, cbChatID, cbChatType, data)
			w.WriteHeader(http.StatusOK)
			return
		}
		go process(chatID, fromID, chatType, text)
		w.WriteHeader(http.StatusOK)
	})
}

func clientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		return fwd
	}
	return r.RemoteAddr
}
