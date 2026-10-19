package tg

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The fleet board must offer one button per box, labeled with its state,
// and the callback data must name the box to mint for.
func TestFleetBoardOffersOneButtonPerBox(t *testing.T) {
	now := time.Now().Unix()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[` +
			`{"id":"home","hostname":"h.example.com","epoch":1,"last_seq":1,"last_ts":1,"last_seen":` + strconv.FormatInt(now, 10) + `,"enrolled":1,"tombstoned":false},` +
			`{"id":"mac","hostname":"m.example.com","epoch":3,"last_seq":1,"last_ts":1,"last_seen":` + strconv.FormatInt(now, 10) + `,"enrolled":1,"tombstoned":true}` +
			`]`))
	}))
	defer srv.Close()
	t.Setenv("OCD_WORKER_URL", srv.URL)
	t.Setenv("OCD_FLEET_TOKEN", "test-token")

	text, boxes, err := fleetBoard()
	if err != nil {
		t.Fatalf("board: %v", err)
	}
	if len(boxes) != 2 {
		t.Fatalf("want 2 boxes, got %d", len(boxes))
	}
	for _, want := range []string{"home", "mac", "Fleet"} {
		if !strings.Contains(text, want) {
			t.Fatalf("board text must mention %q, got:\n%s", want, text)
		}
	}
	rows := boxButton(boxes, time.Now())
	if len(rows) != 1 || len(rows[0]) != 2 {
		t.Fatalf("want one row with two buttons, got %+v", rows)
	}
	if rows[0][0].CallbackData != "flink:home" {
		t.Fatalf("home button data = %q", rows[0][0].CallbackData)
	}
	if !strings.Contains(rows[0][0].Text, "🟢") {
		t.Fatalf("home is online, want a green dot, got %q", rows[0][0].Text)
	}
	if !strings.Contains(rows[0][1].Text, "🟠") {
		t.Fatalf("mac is tombstoned, want an orange dot, got %q", rows[0][1].Text)
	}
}

// A tap must mint a link for the tapped box and hand it over as a URL
// button in the owner's DM.
func TestFleetLinkButtonMintsForTappedBox(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("https://tap.example/?t=tok-1"))
	}))
	defer srv.Close()
	t.Setenv("OCD_WORKER_URL", srv.URL)
	t.Setenv("OCD_FLEET_TOKEN", "test-token")
	link, err := mintBoxLink(context.Background(), "mac")
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	if !strings.Contains(link, "tok-1") {
		t.Fatalf("link = %q", link)
	}
	if gotPath != "/api/backends/mac/link" {
		t.Fatalf("must mint for the tapped box, path = %q", gotPath)
	}
	btn := openButton("🚀 Open mac", link)
	if len(btn.InlineKeyboard) != 1 || len(btn.InlineKeyboard[0]) != 1 {
		t.Fatalf("want one button, got %+v", btn)
	}
	if btn.InlineKeyboard[0][0].URL != link {
		t.Fatalf("button URL = %q", btn.InlineKeyboard[0][0].URL)
	}
}

func TestOpenButtonRendersURL(t *testing.T) {
	btn := openButton("🚀 Open", "https://x.example/?t=1")
	raw, err := json.Marshal(btn)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(raw), "https://x.example/?t=1") {
		t.Fatalf("button must carry the url, got %s", raw)
	}
}
