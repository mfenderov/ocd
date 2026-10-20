package pair_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/mfenderov/ocd/internal/boxagent"
	"github.com/mfenderov/ocd/internal/pair"
	"github.com/mfenderov/ocd/internal/store"
)

func openStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	st.AddDevice("mac", "darwin")
	return st
}

// noBrain clears the brain's env: a tap pushes to the brain only when the
// test says where the brain is.
func noBrain(t *testing.T) {
	t.Helper()
	t.Setenv("OCD_WORKER_URL", "")
	t.Setenv("OCD_BOX_ID", "")
	t.Setenv("OCD_HEARTBEAT_TOKEN", "")
}

func TestNoJWTGives401AndNoMint(t *testing.T) {
	t.Setenv("OCD_PAIR_OPEN", "")
	noBrain(t)
	st := openStore(t)
	tok, _ := st.IssueLink("mac", "telegram")
	h := pair.Handler(st, func() (string, error) { return "LINK", nil })
	req := httptest.NewRequest("GET", "/pair?t="+tok, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", rec.Code)
	}
}

func TestTapMintsAndRedirectsOnce(t *testing.T) {
	t.Setenv("OCD_PAIR_OPEN", "1")
	noBrain(t)
	st := openStore(t)
	tok, _ := st.IssueLink("mac", "telegram")
	calls := 0
	h := pair.Handler(st, func() (string, error) {
		calls++
		return "https://oc.buyallmemes.com/auth/connect/abc", nil
	})
	req := httptest.NewRequest("GET", "/pair?t="+tok, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusFound {
		t.Fatalf("want 302, got %d", rec.Code)
	}
	if calls != 1 {
		t.Fatalf("want 1 mint, got %d", calls)
	}
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, httptest.NewRequest("GET", "/pair?t="+tok, nil))
	if rec2.Code != http.StatusGone {
		t.Fatalf("second tap want 410, got %d", rec2.Code)
	}
	if calls != 1 {
		t.Fatalf("second tap must not re-mint, calls=%d", calls)
	}
}

func TestRawUAStored(t *testing.T) {
	t.Setenv("OCD_PAIR_OPEN", "1")
	noBrain(t)
	ua := "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)"
	st := openStore(t)
	tok, _ := st.IssueLink("mac", "telegram")
	h := pair.Handler(st, func() (string, error) { return "https://x/y", nil })
	r := httptest.NewRequest("GET", "/pair?t="+tok, nil)
	r.Header.Set("User-Agent", ua)
	h.ServeHTTP(httptest.NewRecorder(), r)
	rows := st.RecentAudit(3)
	found := false
	for _, row := range rows {
		if row.Action == "consumed" && row.UA == ua {
			found = true
		}
	}
	if !found {
		t.Fatalf("want consumed row with raw UA, got %+v", rows)
	}
}

func TestMissingTokenIs400(t *testing.T) {
	t.Setenv("OCD_PAIR_OPEN", "1")
	noBrain(t)
	st := openStore(t)
	h := pair.Handler(st, func() (string, error) { return "LINK", nil })
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/pair", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
}

// brainRequest is one event push the box sent to the brain.
type brainRequest struct {
	method string
	path   string
	auth   string
	body   struct {
		ID     string           `json:"id"`
		Events []boxagent.Event `json:"events"`
	}
}

// fakeBrain starts a stand-in for the brain Worker: it records the event
// push it receives and answers with the given status.
func fakeBrain(t *testing.T, status int) <-chan brainRequest {
	t.Helper()
	got := make(chan brainRequest, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req brainRequest
		req.method = r.Method
		req.path = r.URL.Path
		req.auth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &req.body)
		got <- req
		w.WriteHeader(status)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("OCD_WORKER_URL", srv.URL)
	t.Setenv("OCD_BOX_ID", "mac")
	t.Setenv("OCD_HEARTBEAT_TOKEN", "hb-secret")
	return got
}

// A tap tells the brain which link was used: the brain edits the message
// it owns.
func TestTapPushesTheLinkUsedEvent(t *testing.T) {
	t.Setenv("OCD_PAIR_OPEN", "1")
	st := openStore(t)
	tok, _ := st.IssueLink("mac", "telegram")
	brain := fakeBrain(t, http.StatusInternalServerError)

	h := pair.Handler(st, func() (string, error) { return "https://oc.buyallmemes.com/auth/connect/abc", nil })
	r := httptest.NewRequest("GET", "/pair?t="+tok, nil)
	r.Header.Set("X-Forwarded-For", "10.0.0.7")
	r.Header.Set("User-Agent", "Mozilla/5.0 (iPhone)")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	if rec.Code != http.StatusFound {
		t.Fatalf("want 302, got %d", rec.Code)
	}

	var got brainRequest
	select {
	case got = <-brain:
	case <-time.After(5 * time.Second):
		t.Fatal("the brain never received the link-used event")
	}
	if got.method != http.MethodPost {
		t.Fatalf("want POST, got %q", got.method)
	}
	if got.path != "/api/events" {
		t.Fatalf("want /api/events, got %q", got.path)
	}
	if got.auth != "Bearer hb-secret" {
		t.Fatalf("want Authorization %q, got %q", "Bearer hb-secret", got.auth)
	}
	if got.body.ID != "mac" {
		t.Fatalf("want id mac, got %q", got.body.ID)
	}
	if len(got.body.Events) != 1 {
		t.Fatalf("want 1 event, got %d", len(got.body.Events))
	}
	event := got.body.Events[0]
	if event.Type != "link-used" {
		t.Fatalf("want type link-used, got %q", event.Type)
	}
	if event.Token != tok {
		t.Fatalf("want token %q, got %q", tok, event.Token)
	}
	if event.IP != "10.0.0.7" {
		t.Fatalf("want ip 10.0.0.7, got %q", event.IP)
	}
	if event.UA != "Mozilla/5.0 (iPhone)" {
		t.Fatalf("want the raw User-Agent, got %q", event.UA)
	}
}

// The brain is a separate service: its outage must not break a tap. The
// failure is recorded in the box's audit log, never returned to the
// tapper.
func TestBrainOutageDoesNotBreakTheTap(t *testing.T) {
	t.Setenv("OCD_PAIR_OPEN", "1")
	st := openStore(t)
	tok, _ := st.IssueLink("mac", "telegram")
	brain := fakeBrain(t, http.StatusInternalServerError)

	h := pair.Handler(st, func() (string, error) { return "https://oc.buyallmemes.com/auth/connect/abc", nil })
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/pair?t="+tok, nil))
	if rec.Code != http.StatusFound {
		t.Fatalf("a dead brain must not break the tap: want 302, got %d", rec.Code)
	}
	select {
	case <-brain:
	case <-time.After(5 * time.Second):
		t.Fatal("the brain never received the link-used event")
	}
	if !waitForAudit(t, st, "push_failed") {
		t.Fatalf("want a push_failed audit row, got %+v", st.RecentAudit(10))
	}
}

// The push is off the tap's critical path: the tap answers while the
// brain is still thinking.
func TestTapDoesNotWaitForTheBrain(t *testing.T) {
	t.Setenv("OCD_PAIR_OPEN", "1")
	st := openStore(t)
	tok, _ := st.IssueLink("mac", "telegram")

	arrived := make(chan struct{}, 1)
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		arrived <- struct{}{}
		<-release
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(func() {
		close(release)
		srv.Close()
	})
	t.Setenv("OCD_WORKER_URL", srv.URL)
	t.Setenv("OCD_BOX_ID", "mac")
	t.Setenv("OCD_HEARTBEAT_TOKEN", "hb-secret")

	h := pair.Handler(st, func() (string, error) { return "https://oc.buyallmemes.com/auth/connect/abc", nil })
	done := make(chan int, 1)
	go func() {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", "/pair?t="+tok, nil))
		done <- rec.Code
	}()

	select {
	case <-arrived:
	case <-time.After(5 * time.Second):
		t.Fatal("the brain never received the link-used event")
	}
	select {
	case code := <-done:
		if code != http.StatusFound {
			t.Fatalf("want 302, got %d", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the tap waited for the brain")
	}
}

// waitForAudit waits for an audit row with the given action. The push
// failure is written by the push goroutine, so the row lands after the
// tap has answered.
func waitForAudit(t *testing.T, st *store.Store, action string) bool {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		for _, row := range st.RecentAudit(10) {
			if row.Action == action {
				return true
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}
