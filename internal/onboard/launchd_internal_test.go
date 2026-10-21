package onboard

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeLaunchctl installs a stub launchctl on PATH that records the
// command it was asked to run and reports the given state. No test
// loads, boots or prints a real service.
func fakeLaunchctl(t *testing.T, state string) string {
	t.Helper()
	body := "if [ \"$1\" = \"print\" ]; then echo \"\tstate = " + state + "\"; fi\nexit 0\n"
	return fakeBinary(t, "launchctl", body)
}

// plantPlist writes the login service plist where the box looks for it.
func plantPlist(t *testing.T, home string) string {
	t.Helper()
	dir := filepath.Join(home, "Library", "LaunchAgents")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, LaunchdLabel+".plist")
	if err := os.WriteFile(path, []byte("plist"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// The service must be loaded for this login session, not for the
// machine: the box runs inside the operator's session.
func TestBootstrapLaunchdLoadsTheServiceForThisSession(t *testing.T) {
	t.Setenv("UID", "501")
	calls := fakeLaunchctl(t, "running")
	path := filepath.Join(t.TempDir(), LaunchdLabel+".plist")

	if err := BootstrapLaunchd(path); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	got := recordedCalls(t, calls)
	if !strings.Contains(got, "bootstrap gui/501 "+path) {
		t.Fatalf("want the service loaded for this session, got %q", got)
	}
}

// A launchctl that refuses must say so: the operator has to know the
// service is not running.
func TestBootstrapLaunchdReportsAFailedLoad(t *testing.T) {
	t.Setenv("UID", "501")
	calls := fakeBinary(t, "launchctl", "echo 'Load failed: 5: Input/output error'\nexit 1\n")

	err := BootstrapLaunchd(filepath.Join(t.TempDir(), LaunchdLabel+".plist"))
	if err == nil {
		t.Fatal("a failed load must be reported")
	}
	if !strings.Contains(err.Error(), "launchctl bootstrap") {
		t.Fatalf("the error must name the command, got %v", err)
	}
	if got := recordedCalls(t, calls); !strings.Contains(got, "bootstrap gui/501") {
		t.Fatalf("want the service loaded for this session, got %q", got)
	}
}

// The service must be stopped and its plist removed: the goal state is
// "not installed".
func TestUnloadLoginServiceStopsAndRemovesTheService(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("UID", "501")
	calls := fakeLaunchctl(t, "running")
	path := plantPlist(t, home)

	if err := UnloadLoginService(); err != nil {
		t.Fatalf("unload: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("the plist must be gone, got %v", err)
	}
	got := recordedCalls(t, calls)
	if !strings.Contains(got, "bootout gui/501/"+LaunchdLabel) {
		t.Fatalf("want the service stopped for this session, got %q", got)
	}
}

// A service that was never installed is not an error: the goal state is
// already reached.
func TestUnloadLoginServiceToleratesAMissingService(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("UID", "501")
	fakeLaunchctl(t, "running")

	if err := UnloadLoginService(); err != nil {
		t.Fatalf("a missing service is not an error: %v", err)
	}
}

// The install must write the plist and load it: the daemon starts with
// the login.
func TestInstallLoginServiceWritesThePlistAndLoadsIt(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("UID", "501")
	calls := fakeLaunchctl(t, "running")

	path, err := InstallLoginService()
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	want := filepath.Join(home, "Library", "LaunchAgents", LaunchdLabel+".plist")
	if path != want {
		t.Fatalf("want the plist at %q, got %q", want, path)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the plist must be written: %v", err)
	}
	if !strings.Contains(string(raw), LaunchdLabel) {
		t.Fatalf("the plist must name the service, got:\n%s", raw)
	}
	got := recordedCalls(t, calls)
	if !strings.Contains(got, "bootstrap gui/501 "+path) {
		t.Fatalf("want the service loaded, got %q", got)
	}
}

// The status is what launchctl reports: the operator asks whether the
// daemon runs.
func TestServiceStatusReportsTheStateOfTheService(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("UID", "501")
	fakeLaunchctl(t, "running")
	plantPlist(t, home)

	state, err := ServiceStatus()
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if state != "running" {
		t.Fatalf("want the state launchctl reports, got %q", state)
	}
}

// A box with no service installed has nothing to report but that.
func TestServiceStatusReportsAServiceThatIsNotInstalled(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	state, err := ServiceStatus()
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if state != "not installed" {
		t.Fatalf("want a service that is not installed, got %q", state)
	}
}

// A uid that cannot be read leaves the service unknown, not failed.
func TestServiceStatusReportsAnUnreadableUid(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("UID", "")
	t.Setenv("PATH", t.TempDir())
	plantPlist(t, home)

	state, err := ServiceStatus()
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if state != "installed" {
		t.Fatalf("want an installed service, got %q", state)
	}
}

// The uid of the login session comes from the environment.
func TestLoginUIDReadsTheEnvironment(t *testing.T) {
	t.Setenv("UID", "501")

	uid, err := loginUID()
	if err != nil {
		t.Fatalf("uid: %v", err)
	}
	if uid != "501" {
		t.Fatalf("want the uid of the environment, got %q", uid)
	}
}

// Without $UID the box asks the system: the session is the one `id` runs
// in.
func TestLoginUIDAsksTheSystem(t *testing.T) {
	t.Setenv("UID", "")
	fakeBinary(t, "id", "echo 502\n")

	uid, err := loginUID()
	if err != nil {
		t.Fatalf("uid: %v", err)
	}
	if uid != "502" {
		t.Fatalf("want the uid of the session, got %q", uid)
	}
}

// A uid that is not a number cannot address a session.
func TestBootstrapLaunchdRefusesABadUid(t *testing.T) {
	t.Setenv("UID", "not-a-number")
	calls := fakeLaunchctl(t, "running")

	err := BootstrapLaunchd(filepath.Join(t.TempDir(), LaunchdLabel+".plist"))
	if err == nil {
		t.Fatal("a uid that is not a number must be refused")
	}
	if !strings.Contains(err.Error(), "bad uid") {
		t.Fatalf("the error must name the bad uid, got %v", err)
	}
	if _, err := os.Stat(calls); err == nil {
		t.Fatal("no session may be addressed with a bad uid")
	}
}

// A box that cannot read the uid cannot say anything about the
// service.
func TestServiceUIDReportsAnUnreadableUid(t *testing.T) {
	t.Setenv("UID", "")
	t.Setenv("PATH", t.TempDir())

	if _, ok := serviceUID(); ok {
		t.Fatal("an unreadable uid must be reported")
	}
}

// The state launchctl reports is the state the operator reads.
func TestLaunchdStateReadsTheReportedState(t *testing.T) {
	out := "dev.ocd.serve = {\n\tstate = running\n\tpid = 42\n}\n"
	if got := launchdState(out); got != "running" {
		t.Fatalf("want the reported state, got %q", got)
	}
}

// A launchctl that reports no state leaves the service unknown.
func TestLaunchdStateFallsBackToInstalled(t *testing.T) {
	if got := launchdState("dev.ocd.serve = {\n}\n"); got != "installed" {
		t.Fatalf("want an installed service, got %q", got)
	}
}
