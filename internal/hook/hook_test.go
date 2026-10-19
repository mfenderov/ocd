package hook_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/mfenderov/ocd/internal/hook"
	"github.com/mfenderov/ocd/internal/store"
)

func updateJSON(t *testing.T, text string) []byte {
	t.Helper()
	b, _ := json.Marshal(map[string]any{
		"update_id": 42,
		"message": map[string]any{
			"message_id": 7,
			"chat":       map[string]any{"id": 1, "type": "private"},
			"from":       map[string]any{"id": 9},
			"text":       text,
		},
	})
	return b
}

func TestBadSecretGets403AndNoDBWrite(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	h := hook.Handler(st, "s3cr3t", func(updateID int64) bool { return false }, func(chatID, fromID int64, chatType, text string) {}, nil)
	req := httptest.NewRequest("POST", "/webhook", bytes.NewReader(updateJSON(t, "/login")))
	req.Header.Set("X-Telegram-Bot-Api-Secret-Token", "wrong")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("want 403, got %d", rec.Code)
	}
	if rows := st.RecentAudit(5); len(rows) != 1 || rows[0].Action != "hook_denied" {
		t.Fatalf("want only hook_denied, got %+v", rows)
	}
}

func TestReplayProcessedOnce(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	done := make(chan string, 2)
	h := hook.Handler(st, "s3cr3t", st.SeenUpdate, func(chatID, fromID int64, chatType, text string) { done <- text }, nil)
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest("POST", "/webhook", bytes.NewReader(updateJSON(t, "/login")))
		req.Header.Set("X-Telegram-Bot-Api-Secret-Token", "s3cr3t")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("want 200, got %d", rec.Code)
		}
	}
	got := map[string]int{}
	for i := 0; i < 2; i++ {
		select {
		case text := <-done:
			got[text]++
		case <-time.After(2 * time.Second):
		}
	}
	if got["/login"] != 1 {
		t.Fatalf("want exactly 1 process, got %v", got)
	}
}

// An inline-button tap arrives as a callback_query, not a message. The
// webhook must forward it, or buttons silently do nothing.
func TestCallbackQueryIsForwarded(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	got := make(chan string, 2)
	h := hook.Handler(st, "s3cr3t", func(updateID int64) bool { return false },
		func(chatID, fromID int64, chatType, text string) { got <- "message:" + text },
		func(fromID, chatID int64, chatType, data string) { got <- "callback:" + data })
	body, _ := json.Marshal(map[string]any{
		"update_id": 43,
		"callback_query": map[string]any{
			"id":   "cb-1",
			"data": "flink:mac",
			"from": map[string]any{"id": 9},
			"message": map[string]any{
				"message_id": 8,
				"chat":       map[string]any{"id": 1, "type": "private"},
			},
		},
	})
	req := httptest.NewRequest("POST", "/webhook", bytes.NewReader(body))
	req.Header.Set("X-Telegram-Bot-Api-Secret-Token", "s3cr3t")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rec.Code)
	}
	select {
	case g := <-got:
		if g != "callback:flink:mac" {
			t.Fatalf("want the callback data, got %q", g)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("callback never arrived")
	}
}
