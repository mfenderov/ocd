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

func TestLoadEnvFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "env")
	body := "# comment\n\nOCD_FOO=\"bar baz\"\nOCD_EMPTY=\"\"\nPATH=/usr/bin\nINVALID-KEY=x\n"
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	vals, err := onboard.LoadEnvFile(p)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if vals["OCD_FOO"] != "bar baz" || vals["OCD_EMPTY"] != "" {
		t.Fatalf("quoting wrong: %v", vals)
	}
	if _, ok := vals["PATH"]; ok {
		t.Fatal("non-OCD keys must be ignored")
	}
	if len(vals) != 2 {
		t.Fatalf("unexpected keys: %v", vals)
	}
}

func TestApplyEnvDefaultsSkipsPresent(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "env")
	if err := os.WriteFile(p, []byte("OCD_PROBE_X=\"file\"\nOCD_PROBE_Y=\"file\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", dir)
	t.Setenv("OCD_PROBE_X", "explicit")
	// Point ApplyEnvDefaults at the temp file by faking home with .ocd/env.
	if err := os.MkdirAll(filepath.Join(dir, ".ocd"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(p, filepath.Join(dir, ".ocd", "env")); err != nil {
		t.Fatal(err)
	}
	onboard.ApplyEnvDefaults()
	if got := os.Getenv("OCD_PROBE_X"); got != "explicit" {
		t.Fatalf("explicit env must win, got %q", got)
	}
	if got := os.Getenv("OCD_PROBE_Y"); got != "file" {
		t.Fatalf("missing vars fill from file, got %q", got)
	}
}

func TestLaunchdPlist(t *testing.T) {
	out := onboard.LaunchdPlist("/opt/homebrew/bin/ocd", "/Users/x")
	for _, want := range []string{"dev.ocd.serve", "/opt/homebrew/bin/ocd", "<string>serve</string>", "RunAtLoad", "KeepAlive", ".ocd/daemon.log"} {
		if !strings.Contains(out, want) {
			t.Fatalf("plist must contain %q", want)
		}
	}
	dir := t.TempDir()
	p := filepath.Join(dir, "dev.ocd.serve.plist")
	if err := onboard.WriteLaunchdPlist(p, "/opt/homebrew/bin/ocd", "/Users/x"); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := onboard.WriteLaunchdPlist(p, "/opt/homebrew/bin/ocd", "/Users/x"); err == nil {
		t.Fatal("must refuse to overwrite an installed service")
	}
}

func TestDoOnboardWithTunnelEndToEnd(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	t.Setenv("CLOUDFLARE_API_TOKEN", "test-token")
	script := "#!/bin/sh\ncase \"$1 $2\" in\n" +
		"  \"tunnel list\") echo '[]';;\n" +
		"  \"tunnel create\") echo 'Created tunnel oc-t9 with id 99999999-0000-0000-0000-000000000000';;\n" +
		"  \"tunnel route\") exit 0;;\n" +
		"esac\nexit 0\n"
	if err := os.WriteFile(filepath.Join(dir, "cloudflared"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"enrolled","id":"t9"}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	credDir := filepath.Join(dir, ".cloudflared")
	cfg := onboard.Config{
		BoxID: "t9", WorkerURL: srv.URL, PublicHost: "oc-tap-t9.example.com",
		EnvPath: filepath.Join(dir, "env"), DBPath: filepath.Join(dir, "ocd.db"),
		Timeout: 10 * time.Second, PollInterval: time.Millisecond,
		Tunnel: &onboard.TunnelPlan{Name: "oc-t9", TapHost: "oc-tap-t9.example.com", CredDir: credDir, Port: 49400},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := onboard.DoOnboard(ctx, cfg, nil); err != nil {
		t.Fatalf("single-command onboard: %v", err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "env"))
	if !strings.Contains(string(raw), "OCD_MANAGE_TUNNEL=\"1\"") {
		t.Fatalf("env must enable tunnel supervision, got:\n%s", raw)
	}
	tpl, _ := os.ReadFile(filepath.Join(credDir, "config.yml"))
	if !strings.Contains(string(tpl), "aaaaaaaa") && !strings.Contains(string(tpl), "99999999-0000-0000-0000-000000000000") {
		t.Fatalf("tunnel config must carry the created id, got:\n%s", tpl)
	}
}

func TestFormValuesWithDefaults(t *testing.T) {
	got := onboard.FormValues{BoxID: "mac"}.WithDefaults()
	if got.PublicHost != "oc-tap-mac.buyallmemes.com" {
		t.Fatalf("tap host default = %q", got.PublicHost)
	}
	if got.TunnelName != "oc-mac" || got.UIHost != "oc-mac.buyallmemes.com" {
		t.Fatalf("tunnel defaults = %q %q", got.TunnelName, got.UIHost)
	}
	if got.WorkerURL != onboard.DefaultWorkerURL {
		t.Fatalf("worker default = %q", got.WorkerURL)
	}
	keep := onboard.FormValues{BoxID: "mac", PublicHost: "tap.example.com", TunnelName: "t", UIHost: "u.example.com", WorkerURL: "https://w.example"}.WithDefaults()
	if keep.PublicHost != "tap.example.com" || keep.TunnelName != "t" || keep.UIHost != "u.example.com" || keep.WorkerURL != "https://w.example" {
		t.Fatalf("explicit values must survive: %+v", keep)
	}
}

func TestExistingBox(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "env")
	if _, ok := onboard.ExistingBox(p); ok {
		t.Fatal("missing file means fresh box")
	}
	if err := os.WriteFile(p, []byte("# nothing here\nOCD_WORKER_URL=x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := onboard.ExistingBox(p); ok {
		t.Fatal("env without box id means fresh box")
	}
	if err := os.WriteFile(p, []byte("OCD_BOX_ID=\"mac\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	id, ok := onboard.ExistingBox(p)
	if !ok || id != "mac" {
		t.Fatalf("must detect onboarded box, got %q %v", id, ok)
	}
}

func TestFormValuesComplete(t *testing.T) {
	if !(onboard.FormValues{BoxID: "mac", PublicHost: "h.example.com"}.Complete()) {
		t.Fatal("box+host means no form needed")
	}
	if (onboard.FormValues{BoxID: "mac"}.Complete()) {
		t.Fatal("host is required input (or derived later, not complete yet)")
	}
	if (onboard.FormValues{}.Complete()) {
		t.Fatal("empty means form needed")
	}
}
