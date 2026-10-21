package onboard

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeSystemd stands in for the machine: the restart helpers record
// what they asked systemd to do, and no test runs systemctl.
func fakeSystemd(t *testing.T, err error) *[]string {
	t.Helper()
	calls := new([]string)
	old := restartSystemdUnit
	restartSystemdUnit = func(_ context.Context, unit string) error {
		*calls = append(*calls, unit)
		return err
	}
	t.Cleanup(func() { restartSystemdUnit = old })
	return calls
}

// fakeLoginService stands in for the macOS login service.
func fakeLoginService(t *testing.T, err error) *int {
	t.Helper()
	calls := new(int)
	old := restartLoginService
	restartLoginService = func(_ context.Context) error {
		*calls++
		return err
	}
	t.Cleanup(func() { restartLoginService = old })
	return calls
}

// asPlatform runs the test as if the box ran on that OS.
func asPlatform(t *testing.T, name string) {
	t.Helper()
	old := platform
	platform = name
	t.Cleanup(func() { platform = old })
}

// The connector must load the ingress rules that were just written: the
// box's own unit runs it, so the unit is restarted.
func TestRestartTunnelRestartsTheBoxsOwnUnit(t *testing.T) {
	asPlatform(t, "linux")
	calls := fakeSystemd(t, nil)

	notice := restartTunnel(context.Background(), "7ed965a2-9828-46f6-851e-24cf1b9fedf6", false)

	if notice != "" {
		t.Fatalf("a restarted connector is not news, got %q", notice)
	}
	if len(*calls) != 1 || (*calls)[0] != TunnelUnit {
		t.Fatalf("want the tunnel unit restarted, got %v", *calls)
	}
}

// A connector that keeps running keeps the rules it loaded at boot:
// the notice says what did not happen and why.
func TestRestartTunnelReportsAUnitThatCannotBeRestarted(t *testing.T) {
	asPlatform(t, "linux")
	fakeSystemd(t, errors.New("Unit ocd-tunnel.service not loaded."))

	notice := restartTunnel(context.Background(), "7ed965a2-9828-46f6-851e-24cf1b9fedf6", false)

	if notice == "" {
		t.Fatal("a connector that was not restarted must be reported")
	}
	for _, want := range []string{"tunnel", "not restarted", "Unit ocd-tunnel.service not loaded."} {
		if !strings.Contains(notice, want) {
			t.Fatalf("the notice must name %q, got %q", want, notice)
		}
	}
}

// The daemon runs the connector itself: restarting the daemon respawns
// it with the new rules, so there is nothing to restart here.
func TestRestartTunnelLeavesTheConnectorToTheDaemon(t *testing.T) {
	asPlatform(t, "darwin")
	calls := fakeSystemd(t, nil)

	notice := restartTunnel(context.Background(), "7ed965a2-9828-46f6-851e-24cf1b9fedf6", true)

	if notice != "" {
		t.Fatalf("the daemon brings the connector back, got %q", notice)
	}
	if len(*calls) != 0 {
		t.Fatalf("nothing else may be restarted, got %v", *calls)
	}
}

// A box where nothing runs the connector: the operator must start it,
// and the notice says how — by its id, the name is a label.
func TestRestartTunnelReportsAConnectorNobodyRuns(t *testing.T) {
	asPlatform(t, "darwin")

	notice := restartTunnel(context.Background(), "7ed965a2-9828-46f6-851e-24cf1b9fedf6", false)

	if notice == "" {
		t.Fatal("a connector nobody runs must be reported")
	}
	for _, want := range []string{"tunnel", "not restarted", "7ed965a2-9828-46f6-851e-24cf1b9fedf6"} {
		if !strings.Contains(notice, want) {
			t.Fatalf("the notice must name %q, got %q", want, notice)
		}
	}
}

// The daemon must load the env file that was just written: the box's
// own unit runs it, so the unit is restarted.
func TestRestartDaemonRestartsTheBoxsOwnUnit(t *testing.T) {
	asPlatform(t, "linux")
	calls := fakeSystemd(t, nil)

	notice := restartDaemon(context.Background())

	if notice != "" {
		t.Fatalf("a restarted daemon is not news, got %q", notice)
	}
	if len(*calls) != 1 || (*calls)[0] != ServeUnit {
		t.Fatalf("want the serve unit restarted, got %v", *calls)
	}
}

// The daemon keeps the old tokens until it is restarted: the notice
// says what did not happen.
func TestRestartDaemonReportsAUnitThatCannotBeRestarted(t *testing.T) {
	asPlatform(t, "linux")
	fakeSystemd(t, errors.New("Unit ocd-serve.service not loaded."))

	notice := restartDaemon(context.Background())

	if notice == "" {
		t.Fatal("a daemon that was not restarted must be reported")
	}
	for _, want := range []string{"daemon", "not restarted", "Unit ocd-serve.service not loaded."} {
		if !strings.Contains(notice, want) {
			t.Fatalf("the notice must name %q, got %q", want, notice)
		}
	}
}

// The macOS login service runs the daemon: it is reloaded, so the
// daemon comes back with the new env.
func TestRestartDaemonReloadsTheMacLoginService(t *testing.T) {
	asPlatform(t, "darwin")
	home := t.TempDir()
	t.Setenv("HOME", home)
	plantLoginService(t, home)
	calls := fakeLoginService(t, nil)

	notice := restartDaemon(context.Background())

	if notice != "" {
		t.Fatalf("a reloaded daemon is not news, got %q", notice)
	}
	if *calls != 1 {
		t.Fatalf("want the login service reloaded once, got %d", *calls)
	}
}

// A restart must not install the login service: the operator never
// asked for a service, and the notice says what did not happen.
func TestRestartDaemonReportsAMacWithoutALoginService(t *testing.T) {
	asPlatform(t, "darwin")
	t.Setenv("HOME", t.TempDir())
	calls := fakeLoginService(t, nil)

	notice := restartDaemon(context.Background())

	if notice == "" {
		t.Fatal("a daemon that was not restarted must be reported")
	}
	if !strings.Contains(notice, "login service") {
		t.Fatalf("the notice must name the login service, got %q", notice)
	}
	if *calls != 0 {
		t.Fatalf("no service may be installed behind the operator's back, got %d", *calls)
	}
}

// A box that is neither Linux nor macOS has no service of ours: the
// notice says so instead of pretending it worked.
func TestRestartDaemonReportsABoxWithoutAService(t *testing.T) {
	asPlatform(t, "windows")

	notice := restartDaemon(context.Background())

	if notice == "" {
		t.Fatal("a daemon that was not restarted must be reported")
	}
	if !strings.Contains(notice, "daemon") {
		t.Fatalf("the notice must name the daemon, got %q", notice)
	}
}

// A box without a tunnel has no connector: nothing may be restarted for
// it, and nothing may be reported about it.
func TestRestartBoxLeavesABoxWithoutATunnelAlone(t *testing.T) {
	asPlatform(t, "linux")
	calls := fakeSystemd(t, nil)

	res := restartBox(context.Background(), "", false)

	if len(*calls) != 1 || (*calls)[0] != ServeUnit {
		t.Fatalf("only the daemon may be restarted, got %v", *calls)
	}
	if len(res.Notices) != 0 {
		t.Fatalf("a box without a tunnel has no connector, got %v", res.Notices)
	}
}

// A daemon the platform's own service runs is supervised: the operator
// must not start a second one.
func TestRestartBoxSaysTheServiceRunsTheDaemon(t *testing.T) {
	asPlatform(t, "linux")
	fakeSystemd(t, nil)

	res := restartBox(context.Background(), "7ed965a2-9828-46f6-851e-24cf1b9fedf6", false)

	if !res.DaemonRunsAsService {
		t.Fatal("the service that was restarted runs the daemon")
	}
}

// A daemon that could not be restarted is the operator's to start: the
// notice says so, and no service runs it.
func TestRestartBoxSaysNoServiceRunsTheDaemon(t *testing.T) {
	asPlatform(t, "linux")
	fakeSystemd(t, errors.New("Unit ocd-serve.service not loaded."))

	res := restartBox(context.Background(), "7ed965a2-9828-46f6-851e-24cf1b9fedf6", false)

	if res.DaemonRunsAsService {
		t.Fatal("no service runs the daemon")
	}
	if len(res.Notices) != 2 {
		t.Fatalf("the tunnel and the daemon must both be reported, got %v", res.Notices)
	}
}

// plantLoginService writes the macOS login service plist for a test.
func plantLoginService(t *testing.T, home string) {
	t.Helper()
	dir := filepath.Join(home, "Library", "LaunchAgents")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, LaunchdLabel+".plist"), []byte("plist"), 0o600); err != nil {
		t.Fatal(err)
	}
}
