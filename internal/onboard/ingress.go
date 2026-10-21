package onboard

import (
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// Ingress rules: hostname -> local service. The tunnel config is the
// source of truth for a box's hostnames — the naming convention is only a
// default for boxes that have no config yet.

type ingressRule struct {
	Hostname string
	Port     int
}

// The patterns of the two lines a rule is made of. The writer's line
// check is built from them, so a line the parser can read is a line the
// writer can write.
const (
	hostnamePattern = `-\s+hostname:\s*(\S+)`
	servicePattern  = `service:\s*http://127\.0\.0\.1:(\d+)`
)

var hostnameRe = regexp.MustCompile(`(?m)^\s*` + hostnamePattern + `\s*$`)
var serviceRe = regexp.MustCompile(`(?m)^\s*` + servicePattern + `\s*$`)

// ParseIngress reads the hostname/port pairs from a tunnel config.
func ParseIngress(raw string) []ingressRule {
	hosts := hostnameRe.FindAllStringSubmatch(raw, -1)
	ports := serviceRe.FindAllStringSubmatch(raw, -1)
	rules := make([]ingressRule, 0, len(hosts))
	for i, h := range hosts {
		if i >= len(ports) {
			break
		}
		port, err := strconv.Atoi(ports[i][1])
		if err != nil {
			continue
		}
		rules = append(rules, ingressRule{Hostname: h[1], Port: port})
	}
	return rules
}

// conventionalIngressRules are the rules for the hosts the box serves:
// the tap host on the daemon port, the editor host on the OpenCode port.
// On the command line path these are the names the convention gives. One
// hostname gets one rule: cloudflared refuses a config that serves the
// same host twice.
func conventionalIngressRules(tapHost, uiHost string, port, uiPort int) []ingressRule {
	rules := make([]ingressRule, 0, 2)
	seen := make(map[string]bool, 2)
	for _, r := range []ingressRule{
		{Hostname: strings.TrimSpace(tapHost), Port: port},
		{Hostname: strings.TrimSpace(uiHost), Port: uiPort},
	} {
		if r.Hostname == "" || seen[r.Hostname] {
			continue
		}
		seen[r.Hostname] = true
		rules = append(rules, r)
	}
	return rules
}

// desiredIngressRules returns the rules a config should serve: the
// conventional hosts first, then the rules the existing config holds
// that are not the conventional hosts, in the config's own order. The old
// names keep serving and a hand-added rule survives — the new set is a
// superset of the old one, never a replacement.
func desiredIngressRules(tapHost, uiHost string, port, uiPort int, existing []ingressRule) []ingressRule {
	conventional := conventionalIngressRules(tapHost, uiHost, port, uiPort)
	seen := make(map[string]bool, len(conventional)+len(existing))
	rules := make([]ingressRule, 0, len(conventional)+len(existing))
	for _, r := range conventional {
		seen[r.Hostname] = true
		rules = append(rules, r)
	}
	for _, r := range existing {
		if seen[r.Hostname] {
			continue
		}
		seen[r.Hostname] = true
		rules = append(rules, r)
	}
	return rules
}

// sameIngressRules reports whether two rule lists hold the same rules in
// the same order.
func sameIngressRules(a, b []ingressRule) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// RenderIngress writes a tunnel config with the given rules.
func RenderIngress(tunnelID, credFile string, rules []ingressRule) string {
	return renderTunnelConfig(tunnelID, credFile, rules)
}

// TapHostFromConfig returns the hostname serving the daemon (pair links)
// and the one serving OpenCode, as the tunnel config states them.
func TapHostFromConfig(cfgPath string) (tapHost, uiHost string, err error) {
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		return "", "", fmt.Errorf("onboard: read tunnel config: %w", err)
	}
	for _, r := range ParseIngress(string(raw)) {
		if r.Port == DaemonPort && tapHost == "" {
			tapHost = r.Hostname
		}
		if r.Port != DaemonPort && uiHost == "" {
			uiHost = r.Hostname
		}
	}
	if tapHost == "" {
		return "", "", fmt.Errorf("onboard: tunnel config has no rule for the daemon port %d", DaemonPort)
	}
	return tapHost, uiHost, nil
}
