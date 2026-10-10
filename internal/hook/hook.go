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
type ProcessFunc func(chatID, fromID int64, chatType, text string)

func Handler(st *store.Store, secret string, seen func(updateID int64) bool, process ProcessFunc) http.Handler {
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
		var u struct {
			UpdateID int64 `json:"update_id"`
			Message  *struct {
				MessageID int `json:"message_id"`
				Chat      *struct {
					ID   int64  `json:"id"`
					Type string `json:"type"`
				} `json:"chat"`
				From *struct {
					ID int64 `json:"id"`
				} `json:"from"`
				Text string `json:"text"`
			} `json:"message"`
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
