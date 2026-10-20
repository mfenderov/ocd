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
// daemon instead of OpenCode. It only rewrites values it can derive, so
// it never invents infrastructure.
//
// The tunnel config is the source of truth for hostnames: a box's real
// names need not follow the convention (the primary box does not).

var tunnelIDRe = regexp.MustCompile(`(?m)^tunnel:\s*(\S+)\s*$`)
var credFileRe = regexp.MustCompile(`(?m)^credentials-file:\s*(\S+)\s*$`)

// RepairResult lists what changed, for the caller to print.
type RepairResult struct {
	EnvChanged  []string
	TunnelFixed bool
	Restarted   bool
}

// RepairEnv rewrites the derived env values for a box: the tap URL (the
// /pair endpoint of this box's tap host) and the pairing link (the
// editor host OpenCode serves). Hostnames come from the tunnel config
// when it exists, else from the naming convention. Returns the changed
// keys.
func RepairEnv(envPath, boxID string) ([]string, error) {
	vals, err := LoadEnvFile(envPath)
	if err != nil {
		return nil, fmt.Errorf("onboard: read env: %w", err)
	}
	if vals["OCD_BOX_ID"] != boxID {
		return nil, fmt.Errorf("onboard: env holds box %q, not %q", vals["OCD_BOX_ID"], boxID)
	}
	tapHost, uiHost := TapHost(boxID), UIHost(boxID)
	if cfg := tunnelConfigPath(); cfg != "" {
		if t, u, err := TapHostFromConfig(cfg); err == nil {
			tapHost, uiHost = t, u
		}
	}
	want := map[string]string{
		"OCD_PUBLIC_URL": "https://" + tapHost + "/pair",
		"OCD_PAIR_URL":   "https://" + uiHost,
		// A box without this answers 401 to every tap link.
		"OCD_PAIR_OPEN": "1",
	}
	// An absolute DB path: systemd's EnvironmentFile= does not expand
	// $HOME, and a literal "$HOME" once pointed the daemon at an empty
	// database (fresh seq, rejected heartbeats).
	if db, err := DefaultDBPath(); err == nil {
		want["OCD_DB"] = db
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
// daemon and the editor hostname serves OpenCode. Hostnames are kept as
// they are; only the ports are corrected. The OpenCode port is
// discovered from the running service, because it is not fixed. Returns
// true when the file changed.
func RepairTunnel(cfgPath, boxID string) (bool, error) {
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
	uiPort := OpenCodePort
	if p, err := DiscoverOpenCodePort(context.Background()); err == nil {
		uiPort = p
	}
	rules := ParseIngress(string(raw))
	if len(rules) == 0 {
		return false, fmt.Errorf("onboard: tunnel config has no ingress rules")
	}
	hasUI := false
	for i := range rules {
		switch rules[i].Port {
		case DaemonPort:
			// the tap rule: keep the daemon port
		default:
			// the editor rule: follow the running OpenCode service
			rules[i].Port = uiPort
			hasUI = true
		}
	}
	if !hasUI {
		// No editor rule yet: add one next to the tap host.
		rules = append(rules, ingressRule{Hostname: UIHost(boxID), Port: uiPort})
	}
	want := RenderIngress(string(id[1]), credPath, rules)
	if string(raw) == want {
		return false, nil
	}
	if err := os.WriteFile(cfgPath, []byte(want), 0o600); err != nil {
		return false, fmt.Errorf("onboard: write tunnel config: %w", err)
	}
	return true, nil
}

// tunnelConfigPath is the cloudflared config of this box, if any.
func tunnelConfigPath() string {
	dir, err := DefaultCredDir()
	if err != nil {
		return ""
	}
	path := filepath.Join(dir, "config.yml")
	if _, err := os.Stat(path); err != nil {
		return ""
	}
	return path
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
	if cfg := tunnelConfigPath(); cfg != "" {
		fixed, err := RepairTunnel(cfg, boxID)
		if err != nil {
			return res, err
		}
		res.TunnelFixed = fixed
	}
	return res, nil
}

// EnvSummary renders the derived values for one box, for diagnostics.
func EnvSummary(boxID string) string {
	tapHost, uiHost := TapHost(boxID), UIHost(boxID)
	if cfg := tunnelConfigPath(); cfg != "" {
		if t, u, err := TapHostFromConfig(cfg); err == nil {
			tapHost, uiHost = t, u
		}
	}
	var sb strings.Builder
	_, _ = fmt.Fprintf(&sb, "tap url   : https://%s/pair\n", tapHost)
	_, _ = fmt.Fprintf(&sb, "pair url  : https://%s\n", uiHost)
	_, _ = fmt.Fprintf(&sb, "daemon    : 127.0.0.1:%d\n", DaemonPort)
	_, _ = fmt.Fprintf(&sb, "opencode  : 127.0.0.1:%d\n", OpenCodePort)
	return sb.String()
}
