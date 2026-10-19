package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// shouldManageTunnel reports whether `ocd serve` supervises cloudflared
// itself. Opt-in via OCD_MANAGE_TUNNEL=1 (set by `ocd onboard` when it
// provisions a tunnel); boxes with externally managed tunnels (systemd,
// Task Scheduler, manual runs) stay untouched.
func shouldManageTunnel() bool {
	if os.Getenv("OCD_MANAGE_TUNNEL") != "1" {
		return false
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	_, err = os.Stat(filepath.Join(home, ".cloudflared", "config.yml"))
	return err == nil
}

// runTunnel supervises `cloudflared tunnel run` for the life of the
// process, restarting with backoff. Cloudflared replicas are safe: if an
// externally managed tunnel already serves this config, the extra replica
// just shares inbound traffic.
func runTunnel(ctx context.Context, w io.Writer) {
	backoff := 5 * time.Second
	const maxBackoff = 60 * time.Second
	for {
		_, _ = fmt.Fprintln(w, "tunnel: starting cloudflared")
		cmd := exec.CommandContext(ctx, "cloudflared", "tunnel", "run")
		cmd.Stdout = w
		cmd.Stderr = w
		err := cmd.Run()
		select {
		case <-ctx.Done():
			return
		default:
		}
		_, _ = fmt.Fprintf(w, "tunnel: cloudflared exited (%v), retry in %s\n", err, backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}
