package onboard

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// The box's own services, as systemd names them. They are user units:
// the box runs inside the operator's login session.
const (
	// TunnelUnit runs the box's tunnel connector.
	TunnelUnit = "ocd-tunnel.service"
	// ServeUnit runs the box's daemon.
	ServeUnit = "ocd-serve.service"
)

// platform is the OS this box runs on. It is a variable so a test can
// drive every branch from any machine.
var platform = runtime.GOOS

// restartSystemdUnit restarts a systemd user unit. It is a variable so
// a test can stand in for the machine: no test runs systemctl.
var restartSystemdUnit = restartSystemdUnitOnDisk

// restartSystemdUnitOnDisk is the real thing: it asks systemd to
// restart the unit.
func restartSystemdUnitOnDisk(ctx context.Context, unit string) error {
	bin, err := exec.LookPath("systemctl")
	if err != nil {
		return fmt.Errorf("systemctl is not on this box: %w", err)
	}
	cmd := exec.CommandContext(ctx, bin, "--user", "restart", unit)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl --user restart %s: %v %s", unit, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// restartLoginService restarts the macOS login service that runs the
// daemon. It is a variable for the same reason as restartSystemdUnit.
var restartLoginService = func(ctx context.Context) error {
	_, err := InstallLoginService()
	return err
}

// RestartResult is what bringing the box back up did.
type RestartResult struct {
	// Notices name what did not happen and needs the operator.
	Notices []string
	// DaemonRunsAsService says whether the platform's own service runs
	// the daemon: it was restarted, so it is supervised, and the
	// operator must not start a second one.
	DaemonRunsAsService bool
}

// RestartBox brings the box back up with what the onboarding just
// wrote: the tunnel connector must load the ingress rules that were
// just written, and the daemon must load the env file that was just
// written (the tokens the brain now knows, the new tap host).
//
// The tunnel comes first, so the rules are live before the daemon that
// serves them comes back.
//
// It is a variable so a test can stand in for the machine: no test
// restarts a daemon, a tunnel or systemctl.
var RestartBox = restartBox

// restartBox is the real thing: the platform's own services.
func restartBox(ctx context.Context, tunnelID string, daemonRunsTunnel bool) RestartResult {
	var res RestartResult
	// A box without a tunnel has no connector: there is nothing to
	// restart for it.
	if tunnelID != "" {
		if notice := restartTunnel(ctx, tunnelID, daemonRunsTunnel); notice != "" {
			res.Notices = append(res.Notices, notice)
		}
	}
	if notice := restartDaemon(ctx); notice != "" {
		res.Notices = append(res.Notices, notice)
	} else {
		res.DaemonRunsAsService = true
	}
	return res
}

// restartTunnel restarts the box's tunnel connector, so the ingress
// rules that were just written are served.
//
// cloudflared reads the ingress rules at start-up: a connector that is
// not restarted keeps serving the rules it loaded at boot, so the new
// hostnames answer 404.
//
// The notice names what did not happen. It is empty when the connector
// is restarted, or when the daemon will respawn it with the new rules.
func restartTunnel(ctx context.Context, tunnelID string, daemonRunsTunnel bool) string {
	err := restartTunnelService(ctx, tunnelID, daemonRunsTunnel)
	if err == nil {
		return ""
	}
	if daemonRunsTunnel {
		// The daemon runs the connector itself: restarting the daemon
		// respawns it with the new rules.
		return ""
	}
	return "the tunnel was not restarted: " + err.Error() + " — it keeps the old rules until it is restarted"
}

// restartTunnelService restarts the connector the box's own service
// runs.
//
// On Linux that is the systemd user unit. On macOS the daemon runs the
// connector, so the daemon's own restart brings it back with the new
// rules — and a box where nothing runs the connector is the operator's
// to start.
func restartTunnelService(ctx context.Context, tunnelID string, daemonRunsTunnel bool) error {
	if platform == "linux" {
		return restartSystemdUnit(ctx, TunnelUnit)
	}
	if daemonRunsTunnel {
		return nil
	}
	return fmt.Errorf("nothing on this box runs the connector (start it with: cloudflared tunnel run %s)", tunnelID)
}

// restartDaemon restarts the box's daemon, so it loads the env file
// that was just written.
//
// The notice names what did not happen. It is empty when the daemon is
// restarted.
func restartDaemon(ctx context.Context) string {
	err := restartDaemonService(ctx)
	if err == nil {
		return ""
	}
	return daemonNotice(err)
}

// daemonNotice names what did not happen to the daemon.
func daemonNotice(err error) string {
	return "the daemon was not restarted: " + err.Error() + " — it keeps the old tokens until it is restarted"
}

// restartDaemonService restarts the platform's own service for the
// daemon: a systemd user unit on Linux, the login service on macOS.
//
// The macOS login service must exist: a restart must not install a
// service the operator never asked for.
func restartDaemonService(ctx context.Context) error {
	switch platform {
	case "linux":
		return restartSystemdUnit(ctx, ServeUnit)
	case "darwin":
		if !loginServiceInstalled() {
			return fmt.Errorf("no login service runs the daemon")
		}
		return restartLoginService(ctx)
	default:
		return fmt.Errorf("this box has no service that runs the daemon")
	}
}

// loginServiceInstalled says whether the macOS login service is
// installed. A restart must not install it: the operator never asked
// for a service.
func loginServiceInstalled() bool {
	path, err := LaunchdPath()
	if err != nil {
		return false
	}
	_, err = os.Stat(path)
	return err == nil
}
