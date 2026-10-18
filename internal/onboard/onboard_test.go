package onboard_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mfenderov/ocd/internal/onboard"
	"github.com/mfenderov/ocd/internal/store"
)

func TestValidateBoxID(t *testing.T) {
	for _, ok := range []string{"home", "mac", "box-1", "a", "wsl2-node"} {
		if err := onboard.ValidateBoxID(ok); err != nil {
			t.Fatalf("want %q valid: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "UPPER", "has space", "-lead", "trail-", "a/b", strings.Repeat("x", 33)} {
		if err := onboard.ValidateBoxID(bad); err == nil {
			t.Fatalf("want %q rejected", bad)
		}
	}
}

func TestGenerateSecret(t *testing.T) {
	a, err := onboard.GenerateSecret()
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	b, err := onboard.GenerateSecret()
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(a) < 32 || strings.ContainsAny(a, "\n\r") {
		t.Fatalf("secret must be long single-line text, got %q", a)
	}
	if a == b {
		t.Fatal("secrets must differ")
	}
}

func TestWriteEnvFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".ocd", "env")
	if err := onboard.WriteEnvFile(path, map[string]string{"OCD_BOX_ID": "mac"}); err != nil {
		t.Fatalf("write: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !strings.Contains(string(raw), `OCD_BOX_ID="mac"`) {
		t.Fatalf("must persist quoted value, got:\n%s", raw)
	}
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o600 {
		t.Fatalf("env must be 0600, got %o", fi.Mode().Perm())
	}
	// Merge: existing keys survive, values update, unknown lines kept.
	if err := onboard.WriteEnvFile(path, map[string]string{"OCD_BOX_ID": "mac2", "OCD_NEW": "x"}); err != nil {
		t.Fatalf("merge: %v", err)
	}
	raw, _ = os.ReadFile(path)
	for _, want := range []string{`OCD_BOX_ID="mac2"`, `OCD_NEW="x"`} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("merge must contain %q, got:\n%s", want, raw)
		}
	}
}

func TestWaitEnrolled(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if calls.Add(1) < 3 {
			_, _ = w.Write([]byte(`{"enrolled":false}`))
			return
		}
		_, _ = w.Write([]byte(`{"enrolled":true}`))
	}))
	defer srv.Close()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := onboard.WaitEnrolled(ctx, st, srv.Client(), srv.URL, "box-1", "tok", time.Millisecond); err != nil {
		t.Fatalf("wait: %v", err)
	}
	if calls.Load() < 3 {
		t.Fatalf("must poll until enrolled, calls=%d", calls.Load())
	}
}

func TestWaitEnrolledTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := onboard.WaitEnrolled(ctx, st, srv.Client(), srv.URL, "box-1", "tok", time.Millisecond); err == nil {
		t.Fatal("want timeout error when the worker never enrolls")
	}
}

func TestDoOnboardPendingThenApproved(t *testing.T) {
	heartbeats := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/enroll":
			_, _ = w.Write([]byte(`{"status":"pending","id":"mac"}`))
		case "/api/heartbeat":
			heartbeats++
			if heartbeats < 2 {
				_, _ = w.Write([]byte(`{"enrolled":false}`))
			} else {
				_, _ = w.Write([]byte(`{"enrolled":true}`))
			}
		}
	}))
	defer srv.Close()
	dir := t.TempDir()
	var steps []string
	cfg := onboard.Config{
		BoxID:        "mac",
		WorkerURL:    srv.URL,
		PublicHost:   "oc-mac.example.com",
		EnvPath:      dir + "/env",
		DBPath:       dir + "/ocd.db",
		Timeout:      10 * time.Second,
		PollInterval: time.Millisecond,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := onboard.DoOnboard(ctx, cfg, func(s string) { steps = append(steps, s) }); err != nil {
		t.Fatalf("onboard: %v", err)
	}
	raw, _ := os.ReadFile(dir + "/env")
	for _, want := range []string{"OCD_BOX_ID", "OCD_WORKER_URL", "OCD_HEARTBEAT_TOKEN", "OCD_ENROLL_TOKEN", "OCD_ADMIN_TOKEN", "OCD_PUBLIC_URL"} {
		if !strings.Contains(string(raw), want+"=") {
			t.Fatalf("env must define %s, got:\n%s", want, raw)
		}
	}
	if len(steps) == 0 {
		t.Fatal("must report progress")
	}
}

func TestDoOnboardRejectsBadBoxID(t *testing.T) {
	cfg := onboard.Config{BoxID: "Bad Box!"}
	if err := onboard.DoOnboard(context.Background(), cfg, nil); err == nil {
		t.Fatal("want validation error before any network")
	}
}

func TestDoOnboardEnrollCodeSkipsWait(t *testing.T) {
	heartbeats := 0
	var gotToken string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/enroll" {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			gotToken, _ = body["enroll_token"].(string)
			_, _ = w.Write([]byte(`{"status":"enrolled","id":"mac"}`))
			return
		}
		heartbeats++
		_, _ = w.Write([]byte(`{"enrolled":true}`))
	}))
	defer srv.Close()
	dir := t.TempDir()
	cfg := onboard.Config{
		BoxID: "mac", WorkerURL: srv.URL, PublicHost: "oc-mac.example.com",
		EnrollCode: "typed-code-9", EnvPath: dir + "/env", DBPath: dir + "/ocd.db",
		Timeout: 10 * time.Second, PollInterval: time.Millisecond,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := onboard.DoOnboard(ctx, cfg, nil); err != nil {
		t.Fatalf("onboard with code: %v", err)
	}
	if gotToken != "typed-code-9" {
		t.Fatalf("must enroll with the typed code, sent %q", gotToken)
	}
	if heartbeats != 0 {
		t.Fatalf("immediate enroll must not heartbeat, got %d", heartbeats)
	}
}

func TestDoOnboardBadCodeFailsFast(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"pending","id":"mac"}`))
	}))
	defer srv.Close()
	dir := t.TempDir()
	cfg := onboard.Config{
		BoxID: "mac", WorkerURL: srv.URL, PublicHost: "oc-mac.example.com",
		EnrollCode: "stale-code", EnvPath: dir + "/env", DBPath: dir + "/ocd.db",
		Timeout: 10 * time.Second, PollInterval: time.Millisecond,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := onboard.DoOnboard(ctx, cfg, nil); err == nil {
		t.Fatal("rejected code must fail instead of waiting forever")
	}
}
