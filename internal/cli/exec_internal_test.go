package cli

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mfenderov/ocd/internal/onboard"
)

// fakeBinary installs a stub binary on PATH that records the arguments
// it was asked with, and runs the given body. No test runs a real
// system binary.
func fakeBinary(t *testing.T, name, body string) string {
	t.Helper()
	dir := t.TempDir()
	calls := filepath.Join(dir, "calls")
	script := "#!/bin/sh\necho \"$@\" >> " + calls + "\n" + body
	//nolint:gosec // the stub binary must be executable: it stands in for a real one.
	if err := os.WriteFile(filepath.Join(dir, name), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	return calls
}

// recordedCalls is what the stub binary was asked to run.
func recordedCalls(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the stub recorded nothing: %v", err)
	}
	return string(raw)
}

// The link is minted by the real opencode, against the origin the
// environment names.
func TestRealExecMintsALinkAgainstThePairURL(t *testing.T) {
	t.Setenv("OCD_PAIR_URL", "https://oc.example.com")
	calls := fakeBinary(t, "opencode", "echo 'https://oc.example.com/?t=tok-1'\n")

	out, err := realExec(t.Context())
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	if !strings.Contains(out, "https://oc.example.com/?t=tok-1") {
		t.Fatalf("want the link the service printed, got %q", out)
	}
	got := recordedCalls(t, calls)
	if !strings.Contains(got, "pair --url https://oc.example.com") {
		t.Fatalf("want the link minted against the pair url, got %q", got)
	}
}

// Without a pair url the link points at the default origin.
func TestRealExecFallsBackToTheDefaultPairURL(t *testing.T) {
	t.Setenv("OCD_PAIR_URL", "")
	calls := fakeBinary(t, "opencode", "echo 'https://oc.example.com/?t=tok-1'\n")

	if _, err := realExec(t.Context()); err != nil {
		t.Fatalf("mint: %v", err)
	}
	got := recordedCalls(t, calls)
	if !strings.Contains(got, "--url https://oc.buyallmemes.com") {
		t.Fatalf("want the default origin, got %q", got)
	}
}

// A service that cannot mint a link must say so: the operator gets no
// link to hand out.
func TestRealExecReportsAFailedMint(t *testing.T) {
	fakeBinary(t, "opencode", "exit 1\n")

	if _, err := realExec(t.Context()); err == nil {
		t.Fatal("a failed mint must be reported")
	}
}

// The connector is supervised for the life of the box: the run stops
// when the box stops.
func TestRunTunnelStopsWithTheBox(t *testing.T) {
	fakeBinary(t, "cloudflared", "exit 0\n")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var out strings.Builder

	runTunnel(ctx, &out)

	if !strings.Contains(out.String(), "tunnel: starting cloudflared") {
		t.Fatalf("the connector must be started, got %q", out.String())
	}
}

// A stopped box does not wait for the backoff.
func TestWaitForStopsWithTheBox(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if waitFor(ctx, time.Minute) {
		t.Fatal("a stopped box must not wait")
	}
}

// A running box waits out the backoff.
func TestWaitForWaitsOutTheBackoff(t *testing.T) {
	if !waitFor(context.Background(), time.Millisecond) {
		t.Fatal("a running box must wait")
	}
}

// boxWithTunnel plants a box that has a cloudflared config and an env
// file, and returns the path of that env file.
func boxWithTunnel(t *testing.T) string {
	t.Helper()
	envPath := plantTunnelConfig(t)
	plantEnvFile(t, envPath)
	return envPath
}

// plantTunnelConfig plants the cloudflared config of a box and returns
// the path of the env file that box would have.
func plantTunnelConfig(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	credDir := filepath.Join(home, ".cloudflared")
	if err := os.MkdirAll(credDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(credDir, "config.yml"), []byte("tunnel: x"), 0o600); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(home, ".ocd", "env")
}

// plantEnvFile writes the env file of a box.
func plantEnvFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("OCD_BOX_ID=\"home\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

// A box with a tunnel config must have the connector supervised by the
// daemon: nobody else runs it.
func TestEnsureTunnelManagedTurnsTheSupervisionOn(t *testing.T) {
	t.Setenv("OCD_MANAGE_TUNNEL", "")
	envPath := boxWithTunnel(t)

	if err := ensureTunnelManaged(); err != nil {
		t.Fatalf("supervise: %v", err)
	}
	vals, err := onboard.LoadEnvFile(envPath)
	if err != nil {
		t.Fatalf("env: %v", err)
	}
	if vals["OCD_MANAGE_TUNNEL"] != "1" {
		t.Fatalf("the daemon must run the connector, got %q", vals["OCD_MANAGE_TUNNEL"])
	}
}

// A box without a tunnel config has no connector to supervise.
func TestEnsureTunnelManagedLeavesABoxWithoutATunnelAlone(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("OCD_MANAGE_TUNNEL", "")

	if err := ensureTunnelManaged(); err != nil {
		t.Fatalf("supervise: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, ".ocd", "env")); !os.IsNotExist(err) {
		t.Fatalf("nothing must be written, got %v", err)
	}
}

// The environment wins: the operator asked for the daemon to run the
// connector already.
func TestEnsureTunnelManagedKeepsAnExplicitOptIn(t *testing.T) {
	t.Setenv("OCD_MANAGE_TUNNEL", "1")
	envPath := boxWithTunnel(t)

	if err := ensureTunnelManaged(); err != nil {
		t.Fatalf("supervise: %v", err)
	}
	vals, err := onboard.LoadEnvFile(envPath)
	if err != nil {
		t.Fatalf("env: %v", err)
	}
	if vals["OCD_MANAGE_TUNNEL"] != "" {
		t.Fatalf("the env file must be left alone, got %q", vals["OCD_MANAGE_TUNNEL"])
	}
}

// A box with a tunnel config but no env file yet must still get the
// supervision flag: the daemon must run the connector, and the install
// must not report success while the tunnel runs unsupervised.
func TestEnsureTunnelManagedWritesTheFlagIntoANewEnvFile(t *testing.T) {
	t.Setenv("OCD_MANAGE_TUNNEL", "")
	envPath := plantTunnelConfig(t)

	if err := ensureTunnelManaged(); err != nil {
		t.Fatalf("supervise: %v", err)
	}
	vals, err := onboard.LoadEnvFile(envPath)
	if err != nil {
		t.Fatalf("env: %v", err)
	}
	if vals["OCD_MANAGE_TUNNEL"] != "1" {
		t.Fatalf("the daemon must run the connector, got %q", vals["OCD_MANAGE_TUNNEL"])
	}
}
