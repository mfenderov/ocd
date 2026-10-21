package cli_test

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mfenderov/ocd/internal/boxadmin"
	"github.com/mfenderov/ocd/internal/cli"
)

func TestRootHasServe(t *testing.T) {
	root := cli.Root()
	found := false
	for _, c := range root.Commands() {
		if c.Name() == "serve" {
			found = true
		}
	}
	if !found {
		t.Fatal("want serve subcommand")
	}
}

func TestRootHasMintDevicesStatus(t *testing.T) {
	root := cli.Root()
	want := map[string]bool{"mint": false, "devices": false, "status": false}
	for _, c := range root.Commands() {
		if _, ok := want[c.Name()]; ok {
			want[c.Name()] = true
		}
	}
	for name, ok := range want {
		if !ok {
			t.Fatalf("want %s subcommand", name)
		}
	}
}

// The box is a box, not a bot: the daemon serves the pair page, the box
// API and the sweeps, and nothing else. Telegram belongs to the brain, so
// the daemon's log never mentions it.
func TestServeLogsNoTelegram(t *testing.T) {
	addr := freeAddr(t)
	t.Setenv("OCD_SERVE_ADDR", addr)
	t.Setenv("OCD_DB", filepath.Join(t.TempDir(), "serve.db"))
	quietDaemonEnv(t)

	out := &safeBuffer{}
	done := make(chan error, 1)
	go func() { done <- cli.RunServe(t.Context(), out) }()

	waitHealthy(t, addr, done, out)
	if got := out.String(); strings.Contains(strings.ToLower(got), "telegram") {
		t.Fatalf("want no telegram in the daemon log, got %q", got)
	}
}

// quietDaemonEnv is the daemon's environment without a brain: no worker
// URL, no tokens, no admin listener.
func quietDaemonEnv(t *testing.T) {
	t.Helper()
	t.Setenv("OCD_WORKER_URL", "")
	t.Setenv("OCD_HEARTBEAT_TOKEN", "")
	t.Setenv("OCD_ENROLL_TOKEN", "")
	t.Setenv("OCD_BOX_ID", "")
	t.Setenv("OCD_ADMIN_TOKEN", "")
}

// safeBuffer is a mutex-guarded strings.Builder: RunServe's heartbeat
// goroutine and the test read the log concurrently.
type safeBuffer struct {
	mu sync.Mutex
	sb strings.Builder
}

func (b *safeBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.sb.Write(p)
}

func (b *safeBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.sb.String()
}

func TestServeWithoutWorkerURLStillHealthy(t *testing.T) {
	addr := freeAddr(t)

	t.Setenv("OCD_SERVE_ADDR", addr)
	t.Setenv("OCD_DB", filepath.Join(t.TempDir(), "serve.db"))
	quietDaemonEnv(t)

	out := &safeBuffer{}
	done := make(chan error, 1)
	go func() { done <- cli.RunServe(t.Context(), out) }()

	waitHealthy(t, addr, done, out)
	got := out.String()
	if !strings.Contains(got, "heartbeat off") {
		t.Fatalf("want 'heartbeat off' log line when OCD_WORKER_URL unset, got %q", got)
	}
	if !strings.Contains(got, "admin off") {
		t.Fatalf("want 'admin off' log line when OCD_ADMIN_TOKEN unset, got %q", got)
	}
}

func freeAddr(t *testing.T) string {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("find free port: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	return addr
}

func waitHealthy(t *testing.T, addr string, done <-chan error, out *safeBuffer) {
	t.Helper()
	url := "http://" + addr + "/healthz"
	deadline := time.Now().Add(15 * time.Second)
	for {
		resp, err := get(t.Context(), url)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("GET /healthz: want 200, got %d", resp.StatusCode)
			}
			return
		}
		select {
		case err := <-done:
			t.Fatalf("RunServe exited early: %v (output: %q)", err, out.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for /healthz (output: %q)", out.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// get makes a GET request under the caller's context.
func get(ctx context.Context, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	return http.DefaultClient.Do(req)
}

// beat is one heartbeat the worker received.
type beat struct {
	body map[string]any
	auth string
}

// beatLog collects the heartbeats the worker received. The worker answers
// on its own goroutine, so the log guards itself.
type beatLog struct {
	mu    sync.Mutex
	beats []beat
}

func (l *beatLog) add(b beat) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.beats = append(l.beats, b)
}

func (l *beatLog) count() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.beats)
}

func (l *beatLog) first() beat {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.beats[0]
}

// waitForBeats waits until the worker has received at least two
// heartbeats: the 50ms test seam must tick.
func waitForBeats(t *testing.T, done <-chan error, out *safeBuffer, log *beatLog) {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for {
		if log.count() >= 2 {
			return
		}
		select {
		case err := <-done:
			t.Fatalf("RunServe exited early: %v (output: %q)", err, out.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("want >=2 heartbeats in 8s with 50ms interval, got %d (output: %q)",
				log.count(), out.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// assertBeat checks the heartbeat the worker received: the box's identity,
// its version and its bearer.
func assertBeat(t *testing.T, b beat) {
	t.Helper()
	if b.body["id"] != "box-test-1" {
		t.Fatalf("want heartbeat id box-test-1, got %v", b.body["id"])
	}
	if b.body["version"] != boxadmin.Version {
		t.Fatalf("want heartbeat version == boxadmin.Version %q, got %v", boxadmin.Version, b.body["version"])
	}
	if b.auth != "Bearer hb-secret" {
		t.Fatalf("want heartbeat Authorization %q, got %q", "Bearer hb-secret", b.auth)
	}
}

// presenceStatus asks the box API for the presence endpoint and returns
// the status code.
func presenceStatus(t *testing.T, addr, authHeader string) int {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet,
		"http://"+addr+"/_oc/presence", nil)
	if err != nil {
		t.Fatalf("build presence request: %v", err)
	}
	if authHeader != "" {
		req.Header.Set("Authorization", authHeader)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /_oc/presence: %v", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode
}

func TestServeWithWorkerURLBeatsAndServesAdmin(t *testing.T) {
	addr := freeAddr(t)

	log := &beatLog{}
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		log.add(beat{body: body, auth: r.Header.Get("Authorization")})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"enrolled":true}`))
	}))
	defer worker.Close()

	t.Setenv("OCD_SERVE_ADDR", addr)
	t.Setenv("OCD_DB", filepath.Join(t.TempDir(), "serve.db"))
	t.Setenv("OCD_WORKER_URL", worker.URL)
	t.Setenv("OCD_HEARTBEAT_TOKEN", "hb-secret")
	t.Setenv("OCD_ENROLL_TOKEN", "")
	t.Setenv("OCD_BOX_ID", "box-test-1")
	t.Setenv("OCD_ADMIN_TOKEN", "admin-secret")
	t.Setenv("OCD_HEARTBEAT_INTERVAL", "50ms")

	out := &safeBuffer{}
	done := make(chan error, 1)
	go func() { done <- cli.RunServe(t.Context(), out) }()

	waitHealthy(t, addr, done, out)
	waitForBeats(t, done, out, log)
	assertBeat(t, log.first())
	if got := out.String(); !strings.Contains(got, "every 50ms") {
		t.Fatalf("want 'every 50ms' log line with OCD_HEARTBEAT_INTERVAL=50ms, got %q", got)
	}
	if code := presenceStatus(t, addr, "Bearer admin-secret"); code != http.StatusOK {
		t.Fatalf("GET /_oc/presence with token: want 200, got %d", code)
	}
	if code := presenceStatus(t, addr, ""); code != http.StatusUnauthorized {
		t.Fatalf("GET /_oc/presence without token: want 401, got %d", code)
	}
}
