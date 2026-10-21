package cli

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
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

// A hung opencode must not keep the box's goroutine forever: the status
// relay answers within its own deadline and the exec dies with it.
func TestMountAdminStatusDoesNotWaitForAHungOpencode(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	// A fake opencode that never answers. `exec` replaces the shell with
	// sleep, so killing the process kills the sleep too.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "opencode"), []byte("#!/bin/sh\nexec sleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("OCD_ADMIN_TOKEN", "admin-secret")
	mux := http.NewServeMux()
	mountAdmin(mux, io.Discard, st, func() (string, error) { return "", nil })

	req := httptest.NewRequest("GET", "/_oc/status", nil)
	req.Header.Set("Authorization", "Bearer admin-secret")
	rec := httptest.NewRecorder()
	start := time.Now()
	mux.ServeHTTP(rec, req)

	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("the status relay waited for the hung command: %s", elapsed)
	}
	if !strings.Contains(rec.Body.String(), "service=DOWN") {
		t.Fatalf("want a DOWN line, got %q", rec.Body.String())
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
	startSweep(ctx, io.Discard, st, 10*time.Millisecond)

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
	startSweep(ctx, io.Discard, st, 10*time.Millisecond)

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

// The sweep tells the brain about the brain's links. A link the brain
// does not own is not the brain's to hear about: the sweep neither
// reports it nor deletes it.
func TestSweepLeavesLinksTheBrainDoesNotOwnAlone(t *testing.T) {
	st, tok := deadLinkStore(t, "other")
	defer st.Close()
	// The link carries a chat and a message id, so the store's pending
	// edit list can show it. That list is how the test sees the row.
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
		t.Fatalf("want the link never reported, got %d events: %v", count, got)
	}
	// The row must survive: the sweep is not the brain's link business
	// unless the link is the brain's.
	pending := st.PendingEdits()
	if len(pending) != 1 || pending[0].Token != tok {
		t.Fatalf("want the link left alone, got %v", pending)
	}
	if pending[0].Note != "expired" {
		t.Fatalf("want the expired edit still pending, got %q", pending[0].Note)
	}
}

// The box's audit rows are the fleet's history: the sweep pushes them to
// the brain. The watermark says how far the box got, so the rows are
// offered once and a restart does not re-send the whole history.
func TestSweepPushesAuditRows(t *testing.T) {
	st, _ := auditTrail(t)

	var (
		mu    sync.Mutex
		got   []boxagent.Event
		calls int
	)
	brain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Events []boxagent.Event `json:"events"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		got = append(got, body.Events...)
		calls++
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer brain.Close()

	t.Setenv("OCD_WORKER_URL", brain.URL)
	t.Setenv("OCD_BOX_ID", "mac")
	t.Setenv("OCD_HEARTBEAT_TOKEN", "hb-secret")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	startSweep(ctx, io.Discard, st, 10*time.Millisecond)

	// Wait for the first push, then let several more sweeps run: the
	// fast ticker guarantees they do.
	deadline := time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		n := calls
		mu.Unlock()
		if n > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the brain never heard about the audit rows")
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(300 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("want one push of the audit rows, got %d", calls)
	}
	if len(got) != 2 {
		t.Fatalf("want the two audit rows, got %d: %+v", len(got), got)
	}
	if got[0].Type != "audit" || got[1].Type != "audit" {
		t.Fatalf("want two audit events, got %q and %q", got[0].Type, got[1].Type)
	}
	if got[0].Action != "tapped" || got[0].Actor != "web:1.2.3.4" || got[0].IP != "1.2.3.4" ||
		got[0].Device != "mac" || got[0].Result != "ok" || got[0].UA != "curl/8" {
		t.Fatalf("want the tapped row intact, got %+v", got[0])
	}
	if got[1].Action != "tap_denied" || got[1].Result != "used-or-expired" {
		t.Fatalf("want the denied row intact, got %+v", got[1])
	}
	// The rows carry their own times, not the time of the push: the
	// brain keys its history on them, and two rows of one second and one
	// action collapse into one row there.
	rows, err := st.RecentAuditSince(0)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("want the two local rows, got %d", len(rows))
	}
	for i, row := range rows {
		if got[i].At != row.At {
			t.Fatalf("want the row's own time %d, got %d", row.At, got[i].At)
		}
	}
}

// The trail was reset: its rowids started over and the stored watermark
// points past every row that follows. The push must not go silent: the
// sweep repairs the watermark and offers the trail again.
func TestSweepPushesAfterTheAuditTrailWasReset(t *testing.T) {
	st, dbPath := auditTrail(t)
	// The box reported up to a rowid far ahead of the trail.
	if err := st.SetAuditWatermark(5000); err != nil {
		t.Fatal(err)
	}
	st.Close()

	// The trail is reset: the rows are gone and the rowids start over.
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DELETE FROM audit`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO audit(at, actor, action, device, ip, result, ua) VALUES(?,'web:1.2.3.4','tapped','mac','1.2.3.4','ok','curl/8')`, time.Now().Unix()-3600); err != nil {
		t.Fatal(err)
	}
	db.Close()

	st, err = store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	var (
		mu  sync.Mutex
		got []boxagent.Event
	)
	brain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Events []boxagent.Event `json:"events"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		got = append(got, body.Events...)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer brain.Close()

	sweepAuditRows(context.Background(), io.Discard, st, brainConfig(brain.URL), &http.Client{})

	mu.Lock()
	defer mu.Unlock()
	if len(got) != 1 {
		t.Fatalf("want the reset trail's row pushed, got %d events", len(got))
	}
	if got[0].Type != "audit" || got[0].Action != "tapped" {
		t.Fatalf("want the audit row, got %+v", got[0])
	}
	// The watermark is repaired onto the trail's new numbering.
	watermark, err := st.AuditWatermark()
	if err != nil {
		t.Fatal(err)
	}
	if watermark != 1 {
		t.Fatalf("want the watermark repaired onto the trail's numbering, got %d", watermark)
	}
}

// A brain outage must not lose the audit rows: the watermark stays where
// it was, so the next sweep offers the same rows again.
func TestSweepKeepsAuditRowsAfterAFailedPush(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	st.AuditUA("web:1.2.3.4", "tapped", "mac", "1.2.3.4", "ok", "curl/8")

	brain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer brain.Close()

	sweepAuditRows(context.Background(), io.Discard, st, brainConfig(brain.URL), &http.Client{})

	watermark, err := st.AuditWatermark()
	if err != nil {
		t.Fatal(err)
	}
	if watermark != 0 {
		t.Fatalf("want no watermark after a failed push, got %d", watermark)
	}
	rows, err := st.RecentAuditSince(0)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("want the unreported row kept for the next sweep, got %d", len(rows))
	}
}

// auditTrail returns a store holding two audit rows whose times are an
// hour old, and the path of its database file.
//
// The rows are written through the store's own API and their times are
// moved back afterwards: a row written through the API carries the
// current time — the same second a push happens in — so a test could
// not tell the row's time from the time of the push.
func auditTrail(t *testing.T) (*store.Store, string) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "audit.db")
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	st.AuditUA("web:1.2.3.4", "tapped", "mac", "1.2.3.4", "ok", "curl/8")
	st.AuditUA("web:1.2.3.4", "tap_denied", "", "1.2.3.4", "used-or-expired", "")
	st.Close()
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE audit SET at=at-3600`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	st, err = store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st, dbPath
}

// deadLinkStore returns a store holding one link that was never tapped
// and is past its TTL: a dead link. The via says who owns it: the brain
// ("admin") or anyone else.
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
