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

var hostnameRe = regexp.MustCompile(`(?m)^\s*-\s+hostname:\s*(\S+)\s*$`)
var serviceRe = regexp.MustCompile(`(?m)^\s*service:\s*http://127\.0\.0\.1:(\d+)\s*$`)

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

// RenderIngress writes a tunnel config with the given rules.
func RenderIngress(tunnelID, credFile string, rules []ingressRule) string {
	var sb strings.Builder
	_, _ = fmt.Fprintf(&sb, "tunnel: %s\ncredentials-file: %s\ningress:\n", tunnelID, credFile)
	for _, r := range rules {
		_, _ = fmt.Fprintf(&sb, "  - hostname: %s\n    service: http://127.0.0.1:%d\n", r.Hostname, r.Port)
	}
	_, _ = fmt.Fprintf(&sb, "  - service: http_status:404\n")
	return sb.String()
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
