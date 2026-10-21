package onboard_test

import (
	"context"
	"encoding/json"
	"io"
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

// systemd strips single quotes from an EnvironmentFile= value, so the Go
// reader must strip them too: otherwise the daemon reads a token with
// the quotes still glued to it and every request is rejected.
func TestLoadEnvFileStripsSingleQuotes(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "env")
	if err := os.WriteFile(p, []byte("OCD_HEARTBEAT_TOKEN='hb-secret'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	vals, err := onboard.LoadEnvFile(p)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if vals["OCD_HEARTBEAT_TOKEN"] != "hb-secret" {
		t.Fatalf("single quotes must be stripped, got %q", vals["OCD_HEARTBEAT_TOKEN"])
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
	// Refresh is expected: the plist is generated, and a stale copy may
	// point at a binary that moved.
	if err := onboard.WriteLaunchdPlist(p, "/opt/homebrew/bin/ocd2", "/Users/x"); err != nil {
		t.Fatalf("refresh must succeed: %v", err)
	}
	raw, _ := os.ReadFile(p)
	if !strings.Contains(string(raw), "/opt/homebrew/bin/ocd2") {
		t.Fatalf("plist must carry the new binary path, got:\n%s", raw)
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

func TestExistingIdentity(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "env")
	if _, ok := onboard.ExistingIdentity(p); ok {
		t.Fatal("missing file means fresh box")
	}
	if err := os.WriteFile(p, []byte("# nothing here\nOCD_WORKER_URL=x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := onboard.ExistingIdentity(p); ok {
		t.Fatal("env without box id means fresh box")
	}
	env := "OCD_BOX_ID=\"mac\"\nOCD_PUBLIC_URL=\"https://oc-tap-mac.buyallmemes.com/pair\"\nOCD_PAIR_URL=\"https://oc-mac.buyallmemes.com\"\n"
	if err := os.WriteFile(p, []byte(env), 0o600); err != nil {
		t.Fatal(err)
	}
	id, ok := onboard.ExistingIdentity(p)
	if !ok || id.BoxID != "mac" {
		t.Fatalf("must detect onboarded box, got %q %v", id.BoxID, ok)
	}
	// The URLs come from the env file: a box may serve hosts that were
	// set up before the naming convention existed.
	if id.TapURL != "https://oc-tap-mac.buyallmemes.com/pair" {
		t.Fatalf("tap url = %q", id.TapURL)
	}
	if id.UIURL != "https://oc-mac.buyallmemes.com" {
		t.Fatalf("ui url = %q", id.UIURL)
	}
}

func TestTapHostAndUIHost(t *testing.T) {
	if got := onboard.TapHost("mac"); got != "oc-tap-mac.buyallmemes.com" {
		t.Fatalf("tap host = %q", got)
	}
	if got := onboard.UIHost("mac"); got != "oc-mac.buyallmemes.com" {
		t.Fatalf("ui host = %q", got)
	}
}

// The name and the code are the only two things a run needs. Given both,
// no question is asked.
func TestResolveEnrollUsesGivenNameAndCode(t *testing.T) {
	box, code, err := onboard.ResolveEnroll(io.Discard, "mac", "abc123")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if box != "mac" || code != "abc123" {
		t.Fatalf("given name and code must be used, got %q %q", box, code)
	}
}

func TestResolveEnrollRejectsInvalidGivenName(t *testing.T) {
	if _, _, err := onboard.ResolveEnroll(io.Discard, "Mac!", "abc123"); err == nil {
		t.Fatal("want an invalid box name refused")
	}
}

// Without a name there is nobody to ask: say what is missing instead of
// opening a form nobody can fill in.
func TestResolveEnrollWithoutNameNeedsATerminal(t *testing.T) {
	old := onboard.Stdin
	onboard.Stdin = strings.NewReader("")
	t.Cleanup(func() { onboard.Stdin = old })

	_, _, err := onboard.ResolveEnroll(io.Discard, "", "abc123")
	if err == nil {
		t.Fatal("want an error without a terminal")
	}
	if !strings.Contains(err.Error(), "name") {
		t.Fatalf("want the error to name the missing input, got %v", err)
	}
}

// Same for the code: it comes from the bot, so it can only be pasted.
func TestResolveEnrollWithoutCodeNeedsATerminal(t *testing.T) {
	old := onboard.Stdin
	onboard.Stdin = strings.NewReader("")
	t.Cleanup(func() { onboard.Stdin = old })

	_, _, err := onboard.ResolveEnroll(io.Discard, "mac", "")
	if err == nil {
		t.Fatal("want an error without a terminal")
	}
	if !strings.Contains(err.Error(), "code") {
		t.Fatalf("want the error to name the missing input, got %v", err)
	}
}

// /dev/null is a character device but not a terminal: a form cannot
// prompt there, so the plain path must be taken.
func TestIsTTYIsFalseForDevNull(t *testing.T) {
	f, err := os.Open(os.DevNull)
	if err != nil {
		t.Skipf("no %s on this platform: %v", os.DevNull, err)
	}
	defer f.Close()
	old := onboard.Stdin
	onboard.Stdin = f
	t.Cleanup(func() { onboard.Stdin = old })

	if onboard.IsTTY() {
		t.Fatalf("%s is not a terminal", os.DevNull)
	}
}

// Whatever the bot sends must be what the prompt accepts: the
// paste-ready command carries the code as its last field.
func TestAskEnrollCodeAcceptsThePasteReadyCommand(t *testing.T) {
	old := onboard.Stdin
	onboard.Stdin = strings.NewReader(onboard.EnrollCommand("mac", "code-abc") + "\n")
	t.Cleanup(func() { onboard.Stdin = old })

	var sb strings.Builder
	code, err := onboard.AskEnrollCode(&sb, "mac")
	if err != nil {
		t.Fatalf("ask: %v", err)
	}
	if code != "code-abc" {
		t.Fatalf("want the code out of the pasted command, got %q", code)
	}
}

// The pasted code may arrive quoted or wrapped in backticks.
func TestAskEnrollCodeStripsQuotes(t *testing.T) {
	old := onboard.Stdin
	onboard.Stdin = strings.NewReader("`code-abc`\n")
	t.Cleanup(func() { onboard.Stdin = old })

	var sb strings.Builder
	code, err := onboard.AskEnrollCode(&sb, "mac")
	if err != nil {
		t.Fatalf("ask: %v", err)
	}
	if code != "code-abc" {
		t.Fatalf("want the code without the quotes, got %q", code)
	}
}

// The pasted code is the one the bot issues; the command printed tells
// the user which bot command to send.
func TestAskEnrollCodePrintsCommandAndReadsThePaste(t *testing.T) {
	old := onboard.Stdin
	onboard.Stdin = strings.NewReader("code-abc\n")
	t.Cleanup(func() { onboard.Stdin = old })

	var sb strings.Builder
	code, err := onboard.AskEnrollCode(&sb, "mac")
	if err != nil {
		t.Fatalf("ask: %v", err)
	}
	if code != "code-abc" {
		t.Fatalf("want the pasted code, got %q", code)
	}
	if !strings.Contains(sb.String(), "/enrollcode mac") {
		t.Fatalf("want the telegram command, got %q", sb.String())
	}
}

// The code the bot issued IS the box's heartbeat secret: the Worker binds
// the box to the token presented at enrollment. A locally minted token in
// the env file would 401 on every heartbeat.
func TestDoOnboardCodeBecomesHeartbeatSecret(t *testing.T) {
	var presented string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if s, ok := body["enroll_token"].(string); ok {
			presented = s
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"enrolled","id":"mac"}`))
	}))
	defer srv.Close()
	dir := t.TempDir()
	envPath := filepath.Join(dir, "env")
	cfg := onboard.Config{
		BoxID: "mac", WorkerURL: srv.URL, PublicHost: "oc-tap-mac.buyallmemes.com",
		EnrollCode: "code-abc", EnvPath: envPath, DBPath: filepath.Join(dir, "ocd.db"),
		Timeout: 10 * time.Second, PollInterval: time.Millisecond,
	}
	if err := onboard.DoOnboard(context.Background(), cfg, nil); err != nil {
		t.Fatalf("onboard: %v", err)
	}
	if presented != "code-abc" {
		t.Fatalf("enroll must present the code, got %q", presented)
	}
	vals, err := onboard.LoadEnvFile(envPath)
	if err != nil {
		t.Fatalf("load env: %v", err)
	}
	if vals["OCD_HEARTBEAT_TOKEN"] != "code-abc" {
		t.Fatalf("heartbeat secret must be the code, got %q", vals["OCD_HEARTBEAT_TOKEN"])
	}
	if vals["OCD_ENROLL_TOKEN"] != "code-abc" {
		t.Fatalf("enroll token must be the code, got %q", vals["OCD_ENROLL_TOKEN"])
	}
}

func TestServiceStatusWithoutPlist(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	state, err := onboard.ServiceStatus()
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if state != "not installed" {
		t.Fatalf("want 'not installed', got %q", state)
	}
}

// launchd gives a bare environment: without HOME the daemon cannot find
// ~/.ocd/env or the cloudflared config, and without PATH it cannot find
// cloudflared or opencode. The plist must carry both.
func TestLaunchdPlistCarriesHomeAndPath(t *testing.T) {
	out := onboard.LaunchdPlist("/opt/homebrew/bin/ocd", "/Users/x")
	for _, want := range []string{"<key>HOME</key>", "/Users/x", "<key>PATH</key>", "/opt/homebrew/bin"} {
		if !strings.Contains(out, want) {
			t.Fatalf("plist must contain %q, got:\n%s", want, out)
		}
	}
}

// The tap link, the pairing link and the tunnel UI rule must point at
// three different things: the tap endpoint (daemon), the OpenCode UI
// (editor), and the editor's own port in the tunnel.
func TestOnboardWiresTapPairAndUIPort(t *testing.T) {
	dir := t.TempDir()
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"enrolled","id":"mac"}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	// Hermetic: a fake cloudflared on PATH, so the test never touches
	// the real binary, the network, or the account.
	fakeCloudflared(t, map[string]string{
		"tunnel list":   `[]`,
		"tunnel create": "Created tunnel oc-mac with id 11111111-2222-3333-4444-555555555555",
		"tunnel route":  "Added CNAME",
	}, nil)
	plan := onboard.DefaultTunnelPlan("mac")
	plan.CredDir = filepath.Join(dir, ".cloudflared")
	plan.APIToken = "test-token" // no cloudflared login needed
	cfg := onboard.Config{
		BoxID: "mac", WorkerURL: srv.URL, PublicHost: onboard.TapHost("mac"),
		PairURL: "https://" + onboard.UIHost("mac"),
		Tunnel:  &plan,
		EnvPath: filepath.Join(dir, "env"), DBPath: filepath.Join(dir, "ocd.db"),
		Timeout: 10 * time.Second, PollInterval: time.Millisecond,
	}
	if err := onboard.DoOnboard(context.Background(), cfg, nil); err != nil {
		t.Fatalf("onboard: %v", err)
	}
	vals, err := onboard.LoadEnvFile(filepath.Join(dir, "env"))
	if err != nil {
		t.Fatalf("env: %v", err)
	}
	if vals["OCD_PUBLIC_URL"] != "https://oc-tap-mac.buyallmemes.com/pair" {
		t.Fatalf("tap url = %q", vals["OCD_PUBLIC_URL"])
	}
	if vals["OCD_PAIR_URL"] != "https://oc-mac.buyallmemes.com" {
		t.Fatalf("pair url = %q", vals["OCD_PAIR_URL"])
	}
}

// systemd's EnvironmentFile= takes values literally, so "$HOME" in the
// env file must be expanded by the reader — otherwise the daemon opens a
// literal "$HOME" directory and heartbeats with a fresh seq.
func TestLoadEnvFileExpandsHome(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "env")
	if err := os.WriteFile(p, []byte("OCD_DB=\"$HOME/.ocd/ocd.db\"\nOCD_OTHER=\"${HOME}/x\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", dir)
	vals, err := onboard.LoadEnvFile(p)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if vals["OCD_DB"] != dir+"/.ocd/ocd.db" {
		t.Fatalf("OCD_DB = %q", vals["OCD_DB"])
	}
	if vals["OCD_OTHER"] != dir+"/x" {
		t.Fatalf("OCD_OTHER = %q", vals["OCD_OTHER"])
	}
}

// The enrolment tells the brain which tunnel this box uses, so the brain
// can own the box's DNS later.
func TestOnboardSendsTunnelID(t *testing.T) {
	dir := t.TempDir()
	const tunnelID = "99999999-0000-0000-0000-000000000000"
	fakeCloudflared(t, map[string]string{
		"tunnel list":   `[]`,
		"tunnel create": "Created tunnel oc-mac with id " + tunnelID,
		"tunnel route":  "Added CNAME",
	}, nil)
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"enrolled","id":"mac"}`))
	}))
	defer srv.Close()
	plan := onboard.DefaultTunnelPlan("mac")
	plan.CredDir = filepath.Join(dir, ".cloudflared")
	plan.APIToken = "test-token" // no cloudflared login needed
	cfg := onboard.Config{
		BoxID: "mac", WorkerURL: srv.URL, PublicHost: onboard.TapHost("mac"),
		Tunnel:  &plan,
		EnvPath: filepath.Join(dir, "env"), DBPath: filepath.Join(dir, "ocd.db"),
		Timeout: 10 * time.Second, PollInterval: time.Millisecond,
	}
	if err := onboard.DoOnboard(context.Background(), cfg, nil); err != nil {
		t.Fatalf("onboard: %v", err)
	}
	if body["tunnel_id"] != tunnelID {
		t.Fatalf("want tunnel_id %q, got %v", tunnelID, body["tunnel_id"])
	}
}
