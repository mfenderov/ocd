package onboard

import (
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// openCodePortRe matches the port in "http://127.0.0.1:PORT".
var openCodePortRe = regexp.MustCompile(`:(\d+)\s*$`)

// DiscoverOpenCodePort asks the running OpenCode service which port it
// listens on. The port is not fixed — a fresh install picks a free one —
// so the tunnel must follow the service, not a hardcoded default.
func DiscoverOpenCodePort(ctx context.Context) (int, error) {
	bin, err := exec.LookPath("opencode")
	if err != nil {
		return 0, fmt.Errorf("onboard: opencode not found on PATH")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "service", "status").Output()
	if err != nil {
		return 0, fmt.Errorf("onboard: opencode service status: %w", err)
	}
	m := openCodePortRe.FindStringSubmatch(strings.TrimSpace(string(out)))
	if m == nil {
		return 0, fmt.Errorf("onboard: cannot read the opencode service port from %q", strings.TrimSpace(string(out)))
	}
	port, err := strconv.Atoi(m[1])
	if err != nil || port <= 0 {
		return 0, fmt.Errorf("onboard: bad opencode service port %q", m[1])
	}
	return port, nil
}

// OpenCodePortOrDefault discovers the OpenCode port, falling back to the
// documented default when the service is not running (so onboarding can
// still finish; the editor simply is not up yet).
func OpenCodePortOrDefault(ctx context.Context) (int, string) {
	port, err := DiscoverOpenCodePort(ctx)
	if err != nil {
		return OpenCodePort, err.Error()
	}
	return port, ""
}
