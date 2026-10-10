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

type update struct {
	UpdateID int64 `json:"update_id"`
}

func Handler(st *store.Store, secret string, seen func(updateID int64) bool, process func(text string)) http.Handler {
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
		text := ""
		if u.Message != nil {
			text = u.Message.Text
		}
		go process(text)
		w.WriteHeader(http.StatusOK)
	})
}

func clientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		return fwd
	}
	return r.RemoteAddr
}
