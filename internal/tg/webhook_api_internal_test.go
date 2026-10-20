package tg

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
)

// Telegram delivers nothing the webhook did not ask for. Inline-button
// taps arrive as a callback_query, so a webhook that asks only for
// "message" silently never delivers the taps: the buttons stop working
// with no error anywhere.
func TestSetWebhookAsksForCallbackQueries(t *testing.T) {
	var body struct {
		AllowedUpdates []string `json:"allowed_updates"`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"result":true}`))
	}))
	defer srv.Close()
	t.Setenv("OCD_TG_API", srv.URL)
	t.Setenv("OCD_TG_TOKEN", "test-token")
	if err := setWebhook(context.Background(), "https://ocd.example.com/tg", "secret"); err != nil {
		t.Fatalf("setWebhook: %v", err)
	}
	want := []string{"message", "callback_query"}
	if !slices.Equal(body.AllowedUpdates, want) {
		t.Fatalf("allowed_updates = %v, want %v", body.AllowedUpdates, want)
	}
}
