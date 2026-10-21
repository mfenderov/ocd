package cli_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mfenderov/ocd/internal/cli"
	"github.com/mfenderov/ocd/internal/onboard"
)

// runOcd runs the ocd command tree with the given arguments and returns
// what it printed.
func runOcd(t *testing.T, args ...string) (string, error) {
	t.Helper()
	var sb strings.Builder
	root := cli.Root()
	root.SetOut(&sb)
	root.SetErr(&sb)
	root.SetArgs(args)
	err := root.Execute()
	return sb.String(), err
}

// fakeBinaryOnPath installs a stub binary on PATH that runs the given
// body. No test runs a real system binary.
func fakeBinaryOnPath(t *testing.T, name, body string) {
	t.Helper()
	dir := t.TempDir()
	script := "#!/bin/sh\n" + body
	if err := os.WriteFile(filepath.Join(dir, name), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
}

// writeEnvFile writes the env file of a box, with the given content.
func writeEnvFile(t *testing.T, home, content string) string {
	t.Helper()
	path := filepath.Join(home, ".ocd", "env")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// The box must be enrolled: the worker binds it, and the env file holds
// the identity the daemon runs with.
func TestOnboardEnrollsTheBox(t *testing.T) {
	noTerminal(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("OCD_DB", filepath.Join(home, ".ocd", "ocd.db"))
	// Nothing of this machine is asked for: the opencode service is not
	// on PATH, so the default ports are assumed.
	t.Setenv("PATH", t.TempDir())
	old := onboard.RestartBox
	onboard.RestartBox = func(context.Context, string, bool) onboard.RestartResult {
		return onboard.RestartResult{DaemonRunsAsService: true}
	}
	t.Cleanup(func() { onboard.RestartBox = old })
	var asked string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"enrolled"}`))
	}))
	t.Cleanup(srv.Close)

	out, err := runOcd(t, "onboard", "mac", "code-1", "--skip-tunnel", "--worker-url", srv.URL)
	if err != nil {
		t.Fatalf("onboard: %v (output %q)", err, out)
	}
	if !strings.Contains(asked, "/api/enroll") {
		t.Fatalf("the worker must be asked to enroll the box, got %q", asked)
	}
	vals, err := onboard.LoadEnvFile(filepath.Join(home, ".ocd", "env"))
	if err != nil {
		t.Fatalf("env: %v", err)
	}
	if vals["OCD_BOX_ID"] != "mac" {
		t.Fatalf("the env file must hold the box, got %q", vals["OCD_BOX_ID"])
	}
	if vals["OCD_ENROLL_TOKEN"] != "code-1" {
		t.Fatalf("the code must be the box's secret, got %q", vals["OCD_ENROLL_TOKEN"])
	}
}

// A box with a tunnel gets one: the connector is created and its DNS
// routed, so the box serves its hosts.
func TestOnboardProvisionsTheTunnel(t *testing.T) {
	noTerminal(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("OCD_DB", filepath.Join(home, ".ocd", "ocd.db"))
	t.Setenv("PATH", t.TempDir())
	credDir := filepath.Join(home, ".cloudflared")
	if err := os.MkdirAll(credDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(credDir, "cert.pem"), []byte("fake-cert"), 0o600); err != nil {
		t.Fatal(err)
	}
	fakeBinaryOnPath(t, "cloudflared", `key="$1 $2"
case "$key" in
  "tunnel list") printf '%s' '[]' ;;
  "tunnel create") printf '%s' 'Created tunnel oc-mac with id 11111111-2222-3333-4444-555555555555' ;;
  "tunnel route") printf '%s' 'Added CNAME' ;;
esac
exit 0
`)
	old := onboard.RestartBox
	onboard.RestartBox = func(context.Context, string, bool) onboard.RestartResult {
		return onboard.RestartResult{DaemonRunsAsService: true}
	}
	t.Cleanup(func() { onboard.RestartBox = old })
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"enrolled"}`))
	}))
	t.Cleanup(srv.Close)

	out, err := runOcd(t, "onboard", "mac", "code-1", "--worker-url", srv.URL)
	if err != nil {
		t.Fatalf("onboard: %v (output %q)", err, out)
	}
	raw, err := os.ReadFile(filepath.Join(credDir, "config.yml"))
	if err != nil {
		t.Fatalf("the tunnel config must be written: %v", err)
	}
	for _, want := range []string{"11111111-2222-3333-4444-555555555555", "oc-tap-mac.buyallmemes.com"} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("the tunnel config must hold %q, got:\n%s", want, raw)
		}
	}
	vals, err := onboard.LoadEnvFile(filepath.Join(home, ".ocd", "env"))
	if err != nil {
		t.Fatalf("env: %v", err)
	}
	if vals["OCD_MANAGE_TUNNEL"] != "1" {
		t.Fatalf("the daemon must run the connector this run created, got %q", vals["OCD_MANAGE_TUNNEL"])
	}
}

// A box with no login service is told what to do by hand: the service
// install is macOS only.
func TestOnboardWithoutATerminalPrintsTheManualGuidance(t *testing.T) {
	noTerminal(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("OCD_DB", filepath.Join(home, ".ocd", "ocd.db"))
	t.Setenv("PATH", t.TempDir())
	old := onboard.RestartBox
	onboard.RestartBox = func(context.Context, string, bool) onboard.RestartResult {
		return onboard.RestartResult{}
	}
	t.Cleanup(func() { onboard.RestartBox = old })
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"enrolled"}`))
	}))
	t.Cleanup(srv.Close)

	out, err := runOcd(t, "onboard", "mac", "code-1", "--skip-tunnel", "--install-service", "--worker-url", srv.URL)
	if err != nil {
		t.Fatalf("onboard: %v (output %q)", err, out)
	}
	if !strings.Contains(out, "automatic install supports macOS only") {
		t.Fatalf("the operator must be told what to do by hand, got %q", out)
	}
}

// The repair fixes the wiring the box's env file holds, and says what
// it fixed.
func TestRepairFixesTheWiring(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("OCD_DB", filepath.Join(home, ".ocd", "ocd.db"))
	writeEnvFile(t, home, "OCD_BOX_ID=\"mac\"\nOCD_PUBLIC_URL=\"https://old.example.com\"\n")

	out, err := runOcd(t, "repair", "--box-id", "mac")
	if err != nil {
		t.Fatalf("repair: %v (output %q)", err, out)
	}
	if !strings.Contains(out, "env OCD_PUBLIC_URL fixed") {
		t.Fatalf("the repair must report what it fixed, got %q", out)
	}
	if !strings.Contains(out, "tap url   : https://oc-tap-mac.buyallmemes.com/pair") {
		t.Fatalf("the repair must print the derived values, got %q", out)
	}
}

// The box to repair comes from the env file when the caller names none.
func TestRepairTakesTheBoxIDFromTheEnvFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("OCD_DB", filepath.Join(home, ".ocd", "ocd.db"))
	writeEnvFile(t, home, "OCD_BOX_ID=\"home\"\n")

	out, err := runOcd(t, "repair")
	if err != nil {
		t.Fatalf("repair: %v (output %q)", err, out)
	}
	if !strings.Contains(out, "pair url  : https://oc-home.buyallmemes.com") {
		t.Fatalf("the repair must repair the box of the env file, got %q", out)
	}
}

// A box with no identity cannot be repaired: the operator must name it.
func TestRepairWithoutABoxIDIsRefused(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeEnvFile(t, home, "OCD_OTHER=\"x\"\n")

	_, err := runOcd(t, "repair")
	if err == nil {
		t.Fatal("a box without an id must be refused")
	}
	if !strings.Contains(err.Error(), "no box id") {
		t.Fatalf("the error must ask for the box id, got %v", err)
	}
}

// The login service must be installed: the daemon starts with the login.
func TestServiceInstallInstallsTheLoginService(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("UID", "501")
	fakeBinaryOnPath(t, "launchctl", "exit 0\n")

	out, err := runOcd(t, "service", "install")
	if err != nil {
		t.Fatalf("install: %v (output %q)", err, out)
	}
	if !strings.Contains(out, "service installed:") {
		t.Fatalf("the install must say where the service went, got %q", out)
	}
	path := filepath.Join(home, "Library", "LaunchAgents", "dev.ocd.serve.plist")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("the plist must be written: %v", err)
	}
}

// The status of the service is what the operator asks for.
func TestServiceStatusReportsTheState(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	out, err := runOcd(t, "service", "status")
	if err != nil {
		t.Fatalf("status: %v (output %q)", err, out)
	}
	if !strings.Contains(out, "service: not installed") {
		t.Fatalf("the status must say the service is not installed, got %q", out)
	}
}

// The service must be gone: the goal state is "not installed".
func TestServiceUninstallRemovesTheService(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("UID", "501")
	fakeBinaryOnPath(t, "launchctl", "exit 0\n")

	out, err := runOcd(t, "service", "uninstall")
	if err != nil {
		t.Fatalf("uninstall: %v (output %q)", err, out)
	}
	if !strings.Contains(out, "service removed") {
		t.Fatalf("the uninstall must say the service is gone, got %q", out)
	}
}

// The link is minted by the real opencode, and printed for the operator.
func TestMintPrintsTheLink(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("OCD_DB", filepath.Join(home, ".ocd", "ocd.db"))
	fakeBinaryOnPath(t, "opencode", "echo 'https://oc.example.com/?t=tok-1'\n")

	out, err := runOcd(t, "mint", "--device", "mac")
	if err != nil {
		t.Fatalf("mint: %v (output %q)", err, out)
	}
	if !strings.Contains(out, "https://oc.example.com/?t=tok-1") {
		t.Fatalf("the link must be printed, got %q", out)
	}
}

// The status names the service the daemon talks to.
func TestStatusShowsTheService(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("OCD_DB", filepath.Join(home, ".ocd", "ocd.db"))
	fakeBinaryOnPath(t, "opencode", "echo 'http://127.0.0.1:49374'\n")

	out, err := runOcd(t, "status")
	if err != nil {
		t.Fatalf("status: %v (output %q)", err, out)
	}
	if !strings.Contains(out, "service=http://127.0.0.1:49374") {
		t.Fatalf("the status must name the service, got %q", out)
	}
}

// The devices the daemon serves are listed for the operator.
func TestDevicesListShowsTheDevices(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("OCD_DB", filepath.Join(home, ".ocd", "ocd.db"))

	if _, err := runOcd(t, "devices", "add", "mac", "darwin"); err != nil {
		t.Fatalf("add: %v", err)
	}
	out, err := runOcd(t, "devices", "list")
	if err != nil {
		t.Fatalf("list: %v (output %q)", err, out)
	}
	if !strings.Contains(out, "mac") || !strings.Contains(out, "darwin") {
		t.Fatalf("the list must hold the device, got %q", out)
	}
}

// The revoke logs the operator out everywhere: it must be confirmed.
func TestRevokeNeedsConfirmation(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("OCD_DB", filepath.Join(home, ".ocd", "ocd.db"))

	_, err := runOcd(t, "revoke")
	if err == nil {
		t.Fatal("a revoke without confirmation must be refused")
	}
	if !strings.Contains(err.Error(), "confirm with --yes") {
		t.Fatalf("the error must ask for the confirmation, got %v", err)
	}
}

// The confirmed revoke rotates the password: the service is asked to.
func TestRevokeRotatesThePassword(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("OCD_DB", filepath.Join(home, ".ocd", "ocd.db"))
	fakeBinaryOnPath(t, "opencode", "echo 'http://127.0.0.1:49374'\n")

	if _, err := runOcd(t, "revoke", "--yes"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
}
