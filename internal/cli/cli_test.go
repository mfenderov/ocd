package cli_test

import (
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

func TestServeRunsWithoutTelegram(t *testing.T) {
	t.Setenv("OCD_TG_TOKEN", "")
	t.Setenv("OCD_OWNER_ID", "")
	addr := freeAddr(t)
	t.Setenv("OCD_SERVE_ADDR", addr)
	t.Setenv("OCD_DB", filepath.Join(t.TempDir(), "serve.db"))
	t.Setenv("OCD_WEBHOOK_BASE", "")
	t.Setenv("OCD_WORKER_URL", "")
	t.Setenv("OCD_HEARTBEAT_TOKEN", "")
	t.Setenv("OCD_ENROLL_TOKEN", "")
	t.Setenv("OCD_BOX_ID", "")
	t.Setenv("OCD_ADMIN_TOKEN", "")

	out := &safeBuffer{}
	done := make(chan error, 1)
	go func() { done <- cli.RunServe(out) }()

	waitHealthy(t, addr, done, out)
	got := out.String()
	if !strings.Contains(got, "telegram off") {
		t.Fatalf("want 'telegram off' log line when tokens unset, got %q", got)
	}
}

func TestServeRefusesHalfConfiguredTelegram(t *testing.T) {
	t.Setenv("OCD_TG_TOKEN", "test-dummy-token")
	t.Setenv("OCD_OWNER_ID", "")
	var sb strings.Builder
	if err := cli.RunServe(&sb); err == nil {
		t.Fatal("want refusal on token-without-owner")
	}
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
	t.Setenv("OCD_TG_TOKEN", "test-dummy-token")
	t.Setenv("OCD_OWNER_ID", "12345")
	t.Setenv("OCD_DB", filepath.Join(t.TempDir(), "serve.db"))
	t.Setenv("OCD_WEBHOOK_BASE", "")
	t.Setenv("OCD_WORKER_URL", "")
	t.Setenv("OCD_HEARTBEAT_TOKEN", "")
	t.Setenv("OCD_ENROLL_TOKEN", "")
	t.Setenv("OCD_BOX_ID", "")
	t.Setenv("OCD_ADMIN_TOKEN", "")

	out := &safeBuffer{}
	done := make(chan error, 1)
	go func() { done <- cli.RunServe(out) }()

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
	ln, err := net.Listen("tcp", "127.0.0.1:0")
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
		resp, err := http.Get(url)
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

func TestServeWithWorkerURLBeatsAndServesAdmin(t *testing.T) {
	addr := freeAddr(t)

	var mu sync.Mutex
	var bodies []map[string]any
	var auths []string
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		mu.Lock()
		bodies = append(bodies, body)
		auths = append(auths, r.Header.Get("Authorization"))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"enrolled":true}`))
	}))
	defer worker.Close()

	t.Setenv("OCD_SERVE_ADDR", addr)
	t.Setenv("OCD_TG_TOKEN", "test-dummy-token")
	t.Setenv("OCD_OWNER_ID", "12345")
	t.Setenv("OCD_DB", filepath.Join(t.TempDir(), "serve.db"))
	t.Setenv("OCD_WEBHOOK_BASE", "")
	t.Setenv("OCD_WORKER_URL", worker.URL)
	t.Setenv("OCD_HEARTBEAT_TOKEN", "hb-secret")
	t.Setenv("OCD_ENROLL_TOKEN", "")
	t.Setenv("OCD_BOX_ID", "box-test-1")
	t.Setenv("OCD_ADMIN_TOKEN", "admin-secret")
	t.Setenv("OCD_HEARTBEAT_INTERVAL", "50ms")

	out := &safeBuffer{}
	done := make(chan error, 1)
	go func() { done <- cli.RunServe(out) }()

	waitHealthy(t, addr, done, out)

	// The 50ms test seam must tick: at least two beats inside 8s.
	deadline := time.Now().Add(8 * time.Second)
	for {
		mu.Lock()
		n := len(bodies)
		mu.Unlock()
		if n >= 2 {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("RunServe exited early: %v (output: %q)", err, out.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("want >=2 heartbeats in 8s with 50ms interval, got %d (output: %q)", n, out.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	first, auth := bodies[0], auths[0]
	mu.Unlock()
	if first["id"] != "box-test-1" {
		t.Fatalf("want heartbeat id box-test-1, got %v", first["id"])
	}
	if first["version"] != boxadmin.Version {
		t.Fatalf("want heartbeat version == boxadmin.Version %q, got %v", boxadmin.Version, first["version"])
	}
	if auth != "Bearer hb-secret" {
		t.Fatalf("want heartbeat Authorization %q, got %q", "Bearer hb-secret", auth)
	}
	if got := out.String(); !strings.Contains(got, "every 50ms") {
		t.Fatalf("want 'every 50ms' log line with OCD_HEARTBEAT_INTERVAL=50ms, got %q", got)
	}

	presenceStatus := func(authHeader string) int {
		req, err := http.NewRequest("GET", "http://"+addr+"/_oc/presence", nil)
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
	if code := presenceStatus("Bearer admin-secret"); code != http.StatusOK {
		t.Fatalf("GET /_oc/presence with token: want 200, got %d", code)
	}
	if code := presenceStatus(""); code != http.StatusUnauthorized {
		t.Fatalf("GET /_oc/presence without token: want 401, got %d", code)
	}
}
