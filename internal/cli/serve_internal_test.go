package cli

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/mfenderov/ocd/internal/boxagent"
	"github.com/mfenderov/ocd/internal/store"
)

// The brain asks the box which links died. The box answers with the
// service status, behind the same Bearer auth as the other admin routes.
func TestMountAdminServesStatusBehindAuth(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	// The status handler shells out to opencode. An empty PATH makes that
	// exec fail fast, so the test never depends on the real binary.
	t.Setenv("PATH", t.TempDir())
	t.Setenv("OCD_ADMIN_TOKEN", "admin-secret")
	mux := http.NewServeMux()
	mountAdmin(mux, io.Discard, st, func() (string, error) { return "", nil })

	get := func(auth string) (int, string, string) {
		t.Helper()
		req := httptest.NewRequest("GET", "/_oc/status", nil)
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec.Code, rec.Body.String(), rec.Header().Get("Content-Type")
	}

	code, body, ct := get("Bearer admin-secret")
	if code != http.StatusOK {
		t.Fatalf("want 200 with the admin token, got %d: %s", code, body)
	}
	if ct != "text/plain" {
		t.Fatalf("want text/plain, got %q", ct)
	}
	if !strings.Contains(body, "service=") {
		t.Fatalf("want the service status line, got %q", body)
	}
	if code, _, _ := get(""); code != http.StatusUnauthorized {
		t.Fatalf("want 401 without the admin token, got %d", code)
	}
}

// The box owns the link TTL, so the box tells the brain which links died.
// The brain decides what to say about them.
func TestSweepPushesDeadLinksToTheBrain(t *testing.T) {
	st, tok := deadLinkStore(t, "admin")
	defer st.Close()

	var (
		mu     sync.Mutex
		got    []boxagent.Event
		bearer string
		boxID  string
	)
	arrived := make(chan struct{}, 1)
	brain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ID     string           `json:"id"`
			Events []boxagent.Event `json:"events"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		got = append(got, body.Events...)
		bearer = r.Header.Get("Authorization")
		boxID = body.ID
		mu.Unlock()
		select {
		case arrived <- struct{}{}:
		default:
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer brain.Close()

	t.Setenv("OCD_WORKER_URL", brain.URL)
	t.Setenv("OCD_BOX_ID", "mac")
	t.Setenv("OCD_HEARTBEAT_TOKEN", "hb-secret")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	startLinkSweep(ctx, io.Discard, st, 10*time.Millisecond)

	select {
	case <-arrived:
	case <-time.After(5 * time.Second):
		t.Fatal("the brain never heard about the dead link")
	}

	mu.Lock()
	defer mu.Unlock()
	if len(got) == 0 {
		t.Fatal("want at least one event")
	}
	if got[0].Type != "link-expired" {
		t.Fatalf("want a link-expired event, got %q", got[0].Type)
	}
	if got[0].Token != tok {
		t.Fatalf("want the dead token %q, got %q", tok, got[0].Token)
	}
	if bearer != "Bearer hb-secret" {
		t.Fatalf("want the heartbeat bearer, got %q", bearer)
	}
	if boxID != "mac" {
		t.Fatalf("want the box id mac, got %q", boxID)
	}
}

// A dead link is reported exactly once. The sweep keeps running, but the
// token is gone after the first report, so the brain hears about it once.
func TestSweepReportsADeadLinkExactlyOnce(t *testing.T) {
	st, tok := deadLinkStore(t, "admin")
	defer st.Close()

	var (
		mu    sync.Mutex
		got   []boxagent.Event
		count int
	)
	brain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Events []boxagent.Event `json:"events"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		got = append(got, body.Events...)
		count += len(body.Events)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer brain.Close()

	t.Setenv("OCD_WORKER_URL", brain.URL)
	t.Setenv("OCD_BOX_ID", "mac")
	t.Setenv("OCD_HEARTBEAT_TOKEN", "hb-secret")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	startLinkSweep(ctx, io.Discard, st, 10*time.Millisecond)

	// Wait for the first report, then let several more sweeps run: the
	// fast ticker guarantees they do.
	deadline := time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		n := count
		mu.Unlock()
		if n > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the brain never heard about the dead link")
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(300 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if count != 1 {
		t.Fatalf("want the dead link reported exactly once, got %d reports", count)
	}
	if got[0].Token != tok {
		t.Fatalf("want the dead token %q, got %q", tok, got[0].Token)
	}
}

// A dead link is reported once. Once the brain has it, the row goes, so
// no sweep reports the same dead link again and again.
func TestSweepDeletesDeadLinksAfterASuccessfulPush(t *testing.T) {
	st, _ := deadLinkStore(t, "admin")
	defer st.Close()

	brain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer brain.Close()

	sweepDeadLinks(context.Background(), io.Discard, st, brainConfig(brain.URL), &http.Client{})

	got, err := st.ExpiredLinkTokens(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("want the reported token deleted, got %v", got)
	}
}

// A brain outage must not lose the report: the token stays, so the next
// sweep tries again.
func TestSweepKeepsDeadLinksAfterAFailedPush(t *testing.T) {
	st, tok := deadLinkStore(t, "admin")
	defer st.Close()

	brain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer brain.Close()

	sweepDeadLinks(context.Background(), io.Discard, st, brainConfig(brain.URL), &http.Client{})

	got, err := st.ExpiredLinkTokens(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != tok {
		t.Fatalf("want the unreported token kept for the next sweep, got %v", got)
	}
}

// The Go bot's own links are the Go bot's business. The sweep must not
// report them and must not delete them: the Go bot's own sweeper still
// has to edit that Telegram message to "expired".
func TestSweepLeavesTheGoBotsLinksAlone(t *testing.T) {
	st, tok := deadLinkStore(t, "telegram")
	defer st.Close()
	// The Go bot records the chat and message ids on its own links, so
	// its sweeper finds them (internal/tg/tg.go).
	if err := st.SetLinkMessage(tok, 123, 456); err != nil {
		t.Fatal(err)
	}

	var (
		mu    sync.Mutex
		got   []boxagent.Event
		count int
	)
	brain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Events []boxagent.Event `json:"events"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		got = append(got, body.Events...)
		count += len(body.Events)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer brain.Close()

	sweepDeadLinks(context.Background(), io.Discard, st, brainConfig(brain.URL), &http.Client{})

	mu.Lock()
	defer mu.Unlock()
	if count != 0 {
		t.Fatalf("want the Go bot's link never reported, got %d events: %v", count, got)
	}
	// The row must survive: the Go bot's sweeper finds it through
	// PendingEdits and edits the Telegram message to "expired".
	pending := st.PendingEdits()
	if len(pending) != 1 || pending[0].Token != tok {
		t.Fatalf("want the Go bot's link left for its own sweeper, got %v", pending)
	}
	if pending[0].Note != "expired" {
		t.Fatalf("want the Go bot's expired-link edit to still be pending, got %q", pending[0].Note)
	}
}

// deadLinkStore returns a store holding one link that was never tapped
// and is past its TTL: a dead link. The via says who owns it: the brain
// ("admin") or the Go bot ("telegram").
func deadLinkStore(t *testing.T, via string) (*store.Store, string) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "sweep.db")
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	tok, err := st.IssueLink("mac", via)
	if err != nil {
		t.Fatal(err)
	}
	// Age the token past the TTL so it counts as dead. The store is closed
	// first: two open connections to the same file would fight over the
	// write lock.
	st.Close()
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE link_tokens SET created_at=strftime('%s','now')-3600 WHERE token=?`, tok); err != nil {
		t.Fatal(err)
	}
	db.Close()

	st, err = store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	return st, tok
}

// brainConfig is the box's connection to a brain at the given origin.
func brainConfig(brainURL string) boxagent.BrainConfig {
	return boxagent.BrainConfig{BrainURL: brainURL, BoxID: "mac", Token: "hb-secret"}
}
