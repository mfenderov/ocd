package onboard

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// LaunchdLabel is the single per-machine login service.
const LaunchdLabel = "dev.ocd.serve"

// LaunchdPlist renders ~/Library/LaunchAgents/<label>.plist running
// `exe serve`. Logs go to ~/.ocd/daemon.log; env comes from ~/.ocd/env
// via the serve startup path (no shell involved, so launchd works).
func LaunchdPlist(exe, home string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>` + LaunchdLabel + `</string>
  <key>ProgramArguments</key>
  <array>
    <string>` + exe + `</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>` + home + `</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>` + home + `</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>` + filepath.Join(home, ".ocd", "daemon.log") + `</string>
  <key>StandardErrorPath</key>
  <string>` + filepath.Join(home, ".ocd", "daemon.log") + `</string>
</dict>
</plist>
`
}

// LaunchdPath returns the install location for the service plist.
func LaunchdPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("onboard: home dir: %w", err)
	}
	return filepath.Join(home, "Library", "LaunchAgents", LaunchdLabel+".plist"), nil
}

// WriteLaunchdPlist writes the plist (0600). The plist is fully generated
// by us, so refreshing it is expected: an older copy may point at a
// binary that moved or miss environment entries we have since added.
func WriteLaunchdPlist(path, exe, home string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("onboard: mkdir: %w", err)
	}
	return os.WriteFile(path, []byte(LaunchdPlist(exe, home)), 0o600)
}

// BootstrapLaunchd loads the service for this login session (uid from $UID
// or `id -u`). Requires macOS launchctl.
func BootstrapLaunchd(ctx context.Context, path string) error {
	uid, err := loginUID()
	if err != nil {
		return err
	}
	if _, err := strconv.Atoi(uid); err != nil {
		return fmt.Errorf("onboard: bad uid %q", uid)
	}
	// launchctl takes a fixed argv: the uid of this login session and
	// this box's own plist. Nothing from a request reaches it.
	//nolint:gosec // the argv is launchctl's own, with this box's uid and plist.
	out, err := exec.CommandContext(ctx, "launchctl", "bootstrap", "gui/"+uid, path).CombinedOutput()
	if err != nil {
		return fmt.Errorf("onboard: launchctl bootstrap: %w %s", err, out)
	}
	return nil
}

// idCommand runs `id -u`. A variable so a test can stand in for the
// machine: no test runs `id`.
var idCommand = func() ([]byte, error) {
	return exec.Command("id", "-u").Output()
}

// loginUID is the uid of this login session: $UID, else `id -u`. The
// uid is not checked here: only the caller that addresses a session
// with it needs it to be a number.
func loginUID() (string, error) {
	uid := os.Getenv("UID")
	if uid == "" {
		out, err := idCommand()
		if err != nil {
			return "", fmt.Errorf("onboard: uid: %w", err)
		}
		// Trimmed, not sliced: `id -u` that prints nothing must not
		// take the process down.
		uid = strings.TrimSpace(string(out))
	}
	return uid, nil
}

// InstallLoginService writes the plist and bootstraps it for this login
// session. macOS only; callers gate on runtime.GOOS. Re-running refreshes
// the plist: an already-loaded copy is booted out first so the new
// content takes effect.
func InstallLoginService(ctx context.Context) (string, error) {
	path, err := installLoginPlist(ctx)
	if err != nil {
		return "", err
	}
	if err := BootstrapLaunchd(ctx, path); err != nil {
		return path, err
	}
	return path, nil
}

// installLoginPlist writes the plist of the login service, replacing the
// one an older build wrote.
func installLoginPlist(ctx context.Context) (string, error) {
	exe, err := ServiceExecutable()
	if err != nil {
		return "", err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("onboard: home dir: %w", err)
	}
	path, err := LaunchdPath()
	if err != nil {
		return "", err
	}
	_ = UnloadLoginService(ctx)
	if err := WriteLaunchdPlist(path, exe, home); err != nil {
		return "", err
	}
	return path, nil
}
func ServiceExecutable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("onboard: executable: %w", err)
	}
	return exe, nil
}

// UnloadLoginService stops and removes the login service. Missing service
// is not an error: the goal state is "not installed".
func UnloadLoginService(ctx context.Context) error {
	path, err := LaunchdPath()
	if err != nil {
		return err
	}
	uid, err := loginUID()
	if err != nil {
		return err
	}
	// launchctl takes a fixed argv: this box's own uid and label.
	//nolint:gosec // the argv is launchctl's own, with this box's uid and label.
	_ = exec.CommandContext(ctx, "launchctl", "bootout", "gui/"+uid+"/"+LaunchdLabel).Run()
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("onboard: remove plist: %w", err)
	}
	return nil
}

// ServiceStatus reports the launchd service state ("running", "not
// loaded", or the raw state string) and whether the plist exists.
func ServiceStatus(ctx context.Context) (string, error) {
	path, err := LaunchdPath()
	if err != nil {
		return "", err
	}
	if !plistInstalled(path) {
		return "not installed", nil
	}
	uid, ok := serviceUID()
	if !ok {
		return "installed", nil
	}
	state, ok := launchdPrintState(ctx, uid)
	if !ok {
		return "installed (not loaded)", nil
	}
	return state, nil
}

// plistInstalled says whether the service plist is on disk.
func plistInstalled(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// launchdPrintState is the state launchctl reports for the service, and
// whether it reported one at all: a service that is not loaded has no
// state to report.
func launchdPrintState(ctx context.Context, uid string) (string, bool) {
	// launchctl takes a fixed argv: this box's own uid and label.
	//nolint:gosec // the argv is launchctl's own, with this box's uid and label.
	out, err := exec.CommandContext(ctx, "launchctl", "print", "gui/"+uid+"/"+LaunchdLabel).CombinedOutput()
	if err != nil {
		return "", false
	}
	return launchdState(string(out)), true
}

// serviceUID is the uid of this login session, when it can be read:
// $UID, else `id -u`. The second value says whether it was readable: an
// empty uid is not readable, so the service is reported as installed and
// its state unknown.
func serviceUID() (string, bool) {
	// The same rule as the login session's uid, so the two can never
	// drift apart: $UID first, then `id -u` behind the idCommand seam.
	uid, err := loginUID()
	if err != nil || uid == "" {
		return "", false
	}
	return uid, true
}

// launchdState is the state launchctl reports for the service.
func launchdState(out string) string {
	for _, line := range strings.Split(out, "\n") {
		if strings.Contains(line, "state =") {
			return strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "state ="))
		}
	}
	return "installed"
}
