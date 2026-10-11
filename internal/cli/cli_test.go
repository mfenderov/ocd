package cli_test

import (
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

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

func TestServeRefusesWithoutToken(t *testing.T) {
	t.Setenv("OCD_TG_TOKEN", "")
	t.Setenv("OCD_OWNER_ID", "")
	var sb strings.Builder
	if err := cli.RunServe(&sb); err == nil {
		t.Fatal("want refusal without token")
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
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("find free port: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

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
			break
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
	got := out.String()
	if !strings.Contains(got, "heartbeat off") {
		t.Fatalf("want 'heartbeat off' log line when OCD_WORKER_URL unset, got %q", got)
	}
	if !strings.Contains(got, "admin off") {
		t.Fatalf("want 'admin off' log line when OCD_ADMIN_TOKEN unset, got %q", got)
	}
}
