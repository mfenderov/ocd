package boxagent_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/mfenderov/ocd/internal/boxagent"
)

// pushRecorder is what the brain received: the request and the body.
type pushRecorder struct {
	method string
	path   string
	auth   string
	ct     string
	body   struct {
		ID     string           `json:"id"`
		Events []boxagent.Event `json:"events"`
	}
}

// pushServer starts a brain that records what it received.
func pushServer(t *testing.T, rec *pushRecorder) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.method = r.Method
		rec.path = r.URL.Path
		rec.auth = r.Header.Get("Authorization")
		rec.ct = r.Header.Get("Content-Type")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &rec.body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// The brain authenticates the box with the same bearer the heartbeat uses
// and reads the box id from the body: a console token must not be able to
// forge box events.
func TestPushEventsPostsTheBox(t *testing.T) {
	var rec pushRecorder
	srv := pushServer(t, &rec)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	events := []boxagent.Event{{Type: "link-used", Token: "tok-1", IP: "1.2.3.4"}}
	if err := boxagent.PushEvents(ctx, srv.Client(), srv.URL, "mac", "hb-secret", events); err != nil {
		t.Fatalf("PushEvents: %v", err)
	}
	if rec.method != http.MethodPost {
		t.Fatalf("want POST, got %q", rec.method)
	}
	if rec.path != "/api/events" {
		t.Fatalf("want /api/events, got %q", rec.path)
	}
	if rec.auth != "Bearer hb-secret" {
		t.Fatalf("want Authorization %q, got %q", "Bearer hb-secret", rec.auth)
	}
	if rec.ct != "application/json" {
		t.Fatalf("want Content-Type application/json, got %q", rec.ct)
	}
	if rec.body.ID != "mac" {
		t.Fatalf("want id mac, got %v", rec.body.ID)
	}
}

// The events are the box's own record: each one carries its type, its
// token and its address.
func TestPushEventsPostsTheEvents(t *testing.T) {
	var rec pushRecorder
	srv := pushServer(t, &rec)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	events := []boxagent.Event{{Type: "link-used", Token: "tok-1", IP: "1.2.3.4"}}
	if err := boxagent.PushEvents(ctx, srv.Client(), srv.URL, "mac", "hb-secret", events); err != nil {
		t.Fatalf("PushEvents: %v", err)
	}
	if len(rec.body.Events) != 1 {
		t.Fatalf("want 1 event, got %d", len(rec.body.Events))
	}
	if rec.body.Events[0].Type != "link-used" {
		t.Fatalf("want type link-used, got %q", rec.body.Events[0].Type)
	}
	if rec.body.Events[0].Token != "tok-1" {
		t.Fatalf("want token tok-1, got %q", rec.body.Events[0].Token)
	}
	if rec.body.Events[0].IP != "1.2.3.4" {
		t.Fatalf("want ip 1.2.3.4, got %q", rec.body.Events[0].IP)
	}
}

// The push is best effort, but a brain that answers with an error must
// say so: the caller logs it and moves on.
func TestPushEventsFailsOnANon2xxAnswer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := boxagent.PushEvents(ctx, srv.Client(), srv.URL, "mac", "hb-secret", []boxagent.Event{{Type: "link-used"}})
	if err == nil {
		t.Fatal("want an error on 500, got nil")
	}
}

// The brain URL arrives in the box's canonical form: OCD_WORKER_URL ends
// in /api/heartbeat. The event path must resolve under the origin either
// way, or every push 404s.
func TestPushEventsResolvesTheEventPathUnderTheOrigin(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, base := range []string{srv.URL, srv.URL + "/", srv.URL + "/api/heartbeat"} {
		gotPath = ""
		events := []boxagent.Event{{Type: "link-used"}}
		if err := boxagent.PushEvents(ctx, srv.Client(), base, "mac", "hb-secret", events); err != nil {
			t.Fatalf("base %q: %v", base, err)
		}
		if gotPath != "/api/events" {
			t.Fatalf("base %q resolved to %q, want /api/events", base, gotPath)
		}
	}
}

// An eventless push is a wasted request: the brain has nothing to do.
func TestPushEventsWithoutEventsNeverCallsTheBrain(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := boxagent.PushEvents(ctx, srv.Client(), srv.URL, "mac", "hb-secret", nil); err != nil {
		t.Fatalf("PushEvents: %v", err)
	}
	if hits != 0 {
		t.Fatalf("want zero HTTP calls, got %d", hits)
	}
}

// The box id is the box's identity in the body and the bearer is its
// credential: without them the brain cannot tell the events apart.
func TestPushEventsRefusesAnUnauthenticatedPush(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	events := []boxagent.Event{{Type: "link-used"}}
	if err := boxagent.PushEvents(ctx, srv.Client(), srv.URL, "", "hb-secret", events); err == nil {
		t.Fatal("want an error for an empty box id")
	}
	if err := boxagent.PushEvents(ctx, srv.Client(), srv.URL, "mac", "", events); err == nil {
		t.Fatal("want an error for an empty token")
	}
	if hits != 0 {
		t.Fatalf("must not hit the network on invalid input, got %d calls", hits)
	}
}
