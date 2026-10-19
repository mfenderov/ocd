package onboard

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Repair fixes a box that was onboarded by an older build: the env file
// may point the tap link at the wrong path, the pairing link at the
// wrong host, and the tunnel may route the editor hostname to the
// daemon instead of OpenCode. It only rewrites values it can derive
// from the box id, so it never invents infrastructure.

var tunnelIDRe = regexp.MustCompile(`(?m)^tunnel:\s*(\S+)\s*$`)
var credFileRe = regexp.MustCompile(`(?m)^credentials-file:\s*(\S+)\s*$`)

// RepairResult lists what changed, for the caller to print.
type RepairResult struct {
	EnvChanged  []string
	TunnelFixed bool
	Restarted   bool
}

// RepairEnv rewrites the derived env values for a box: the tap URL
// (the /pair endpoint of this box's tap host) and the pairing link (the
// editor host OpenCode serves). Returns the changed keys.
func RepairEnv(envPath, boxID string) ([]string, error) {
	vals, err := LoadEnvFile(envPath)
	if err != nil {
		return nil, fmt.Errorf("onboard: read env: %w", err)
	}
	if vals["OCD_BOX_ID"] != boxID {
		return nil, fmt.Errorf("onboard: env holds box %q, not %q", vals["OCD_BOX_ID"], boxID)
	}
	want := map[string]string{
		"OCD_PUBLIC_URL": "https://" + TapHost(boxID) + "/pair",
		"OCD_PAIR_URL":   "https://" + UIHost(boxID),
		// A box without this answers 401 to every tap link.
		"OCD_PAIR_OPEN": "1",
	}
	changed := []string{}
	for k, v := range want {
		if vals[k] != v {
			changed = append(changed, k)
		}
	}
	if len(changed) == 0 {
		return nil, nil
	}
	if err := WriteEnvFile(envPath, want); err != nil {
		return nil, err
	}
	return changed, nil
}

// RepairTunnel rewrites the tunnel config so the tap hostname serves the
// daemon and the editor hostname serves OpenCode. It keeps the same
// tunnel id and credentials file, so the tunnel stays the same one
// Cloudflare knows. The OpenCode port is discovered from the running
// service, because it is not fixed. Returns true when the file changed.
func RepairTunnel(cfgPath, boxID string) (bool, error) {
	uiPort := OpenCodePort
	if p, err := DiscoverOpenCodePort(context.Background()); err == nil {
		uiPort = p
	}
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		return false, fmt.Errorf("onboard: read tunnel config: %w", err)
	}
	id := tunnelIDRe.FindSubmatch(raw)
	cred := credFileRe.FindSubmatch(raw)
	if id == nil {
		return false, fmt.Errorf("onboard: tunnel config has no tunnel id")
	}
	credPath := filepath.Join(filepath.Dir(cfgPath), string(id[1])+".json")
	if cred != nil {
		credPath = string(cred[1])
	}
	want := renderTunnelConfig(string(id[1]), credPath, TapHost(boxID), UIHost(boxID), DaemonPort, uiPort)
	if string(raw) == want {
		return false, nil
	}
	if err := os.WriteFile(cfgPath, []byte(want), 0o600); err != nil {
		return false, fmt.Errorf("onboard: write tunnel config: %w", err)
	}
	return true, nil
}

// Repair runs the whole repair: env values, tunnel config, and (on
// macOS) a service restart so both take effect.
func Repair(boxID string) (RepairResult, error) {
	var res RepairResult
	envPath, err := DefaultEnvPath()
	if err != nil {
		return res, err
	}
	changed, err := RepairEnv(envPath, boxID)
	if err != nil {
		return res, err
	}
	res.EnvChanged = changed
	credDir, err := DefaultCredDir()
	if err != nil {
		return res, err
	}
	fixed, err := RepairTunnel(filepath.Join(credDir, "config.yml"), boxID)
	if err != nil {
		return res, err
	}
	res.TunnelFixed = fixed
	return res, nil
}

// EnvSummary renders the derived values for one box, for diagnostics.
func EnvSummary(boxID string) string {
	var sb strings.Builder
	_, _ = fmt.Fprintf(&sb, "tap url   : https://%s/pair\n", TapHost(boxID))
	_, _ = fmt.Fprintf(&sb, "pair url  : https://%s\n", UIHost(boxID))
	_, _ = fmt.Fprintf(&sb, "daemon    : 127.0.0.1:%d\n", DaemonPort)
	_, _ = fmt.Fprintf(&sb, "opencode  : 127.0.0.1:%d\n", OpenCodePort)
	return sb.String()
}
