package onboard

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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

// WriteLaunchdPlist writes the plist (0600). Refuses to overwrite.
func WriteLaunchdPlist(path, exe, home string) error {
	if _, err := os.Stat(path); err == nil {
		return fmt.Errorf("onboard: %s exists — remove it first to reinstall", path)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("onboard: mkdir: %w", err)
	}
	return os.WriteFile(path, []byte(LaunchdPlist(exe, home)), 0o600)
}

// BootstrapLaunchd loads the service for this login session (uid from $UID
// or `id -u`). Requires macOS launchctl.
func BootstrapLaunchd(path string) error {
	uid := os.Getenv("UID")
	if uid == "" {
		out, err := exec.Command("id", "-u").Output()
		if err != nil {
			return fmt.Errorf("onboard: uid: %w", err)
		}
		uid = string(out[:len(out)-1])
	}
	if _, err := strconv.Atoi(uid); err != nil {
		return fmt.Errorf("onboard: bad uid %q", uid)
	}
	out, err := exec.Command("launchctl", "bootstrap", "gui/"+uid, path).CombinedOutput()
	if err != nil {
		return fmt.Errorf("onboard: launchctl bootstrap: %v %s", err, out)
	}
	return nil
}

// InstallLoginService writes the plist and bootstraps it for this login
// session. macOS only; callers gate on runtime.GOOS.
func InstallLoginService() (string, error) {
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
	if err := WriteLaunchdPlist(path, exe, home); err != nil {
		return "", err
	}
	if err := BootstrapLaunchd(path); err != nil {
		return path, err
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
