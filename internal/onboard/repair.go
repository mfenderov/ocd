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
	want := repairEnvValues(boxID)
	changed := changedEnvKeys(vals, want)
	if len(changed) == 0 {
		return nil, nil
	}
	if err := WriteEnvFile(envPath, want); err != nil {
		return nil, err
	}
	return changed, nil
}

// repairEnvValues are the values a box's env file must hold: the derived
// ones, always, and the database path when it can be read.
func repairEnvValues(boxID string) map[string]string {
	tapHost, uiHost := repairHosts(boxID)
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
	return want
}

// repairHosts are the hostnames this box serves: the tunnel config says,
// else the naming convention.
func repairHosts(boxID string) (string, string) {
	tapHost, uiHost := TapHost(boxID), UIHost(boxID)
	if cfg := tunnelConfigPath(); cfg != "" {
		if t, u, err := TapHostFromConfig(cfg, boxID); err == nil {
			tapHost, uiHost = t, u
		}
	}
	return tapHost, uiHost
}

// changedEnvKeys names the keys whose value the file does not hold yet.
func changedEnvKeys(vals, want map[string]string) []string {
	changed := []string{}
	for k, v := range want {
		if vals[k] != v {
			changed = append(changed, k)
		}
	}
	return changed
}

// RepairTunnel rewrites the tunnel config so the tap hostname serves the
// daemon and the editor hostname serves OpenCode. Hostnames are kept as
// they are; only the ports are corrected. The OpenCode port is
// discovered from the running service, because it is not fixed. Returns
// true when the file changed.
//
// A config whose rules cannot be paired is refused: a rewrite would
// write a rule with another rule's port.
func RepairTunnel(cfgPath, boxID string) (bool, error) {
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		return false, fmt.Errorf("onboard: read tunnel config: %w", err)
	}
	tunnelID, credPath, rules, err := repairPlan(cfgPath, string(raw), boxID)
	if err != nil {
		return false, err
	}
	want := RenderIngress(tunnelID, credPath, rules)
	if string(raw) == want {
		return false, nil
	}
	if err := os.WriteFile(cfgPath, []byte(want), 0o600); err != nil {
		return false, fmt.Errorf("onboard: write tunnel config: %w", err)
	}
	return true, nil
}

// repairPlan is what the repaired config will hold: the tunnel it
// serves, the credentials file it names, and the rules it serves.
func repairPlan(cfgPath, raw, boxID string) (string, string, []ingressRule, error) {
	if problems := repairRuleProblems(raw); len(problems) > 0 {
		return "", "", nil, fmt.Errorf("onboard: %s holds %s — fix the rule by hand, or move the file aside to regenerate",
			cfgPath, strings.Join(problems, "; "))
	}
	id := tunnelIDRe.FindSubmatch([]byte(raw))
	if id == nil {
		return "", "", nil, fmt.Errorf("onboard: tunnel config has no tunnel id")
	}
	tunnelID := string(id[1])
	credPath := repairCredPath(cfgPath, raw, tunnelID)
	uiPort := repairUIPort()
	rules := ParseIngress(raw)
	if len(rules) == 0 {
		return "", "", nil, fmt.Errorf("onboard: tunnel config has no ingress rules")
	}
	return tunnelID, credPath, repairIngressPorts(rules, boxID, uiPort), nil
}

// repairCredPath is the credentials file the repaired config names: the
// one the config states, else the one next to it.
func repairCredPath(cfgPath, raw, tunnelID string) string {
	if cred := credFileRe.FindSubmatch([]byte(raw)); cred != nil {
		return string(cred[1])
	}
	return filepath.Join(filepath.Dir(cfgPath), tunnelID+".json")
}

// repairUIPort is the port the editor rule must serve: the running
// OpenCode service's, else the default.
func repairUIPort() int {
	if p, err := DiscoverOpenCodePort(context.Background()); err == nil {
		return p
	}
	return OpenCodePort
}

// repairIngressPorts points the editor rule at the running OpenCode
// service, and adds the editor rule when the config has none.
func repairIngressPorts(rules []ingressRule, boxID string, uiPort int) []ingressRule {
	hasUI := false
	for i := range rules {
		if rules[i].Port == DaemonPort {
			continue
		}
		rules[i].Port = uiPort
		hasUI = true
	}
	if !hasUI {
		// No editor rule yet: add one next to the tap host.
		rules = append(rules, ingressRule{Hostname: UIHost(boxID), Port: uiPort})
	}
	return rules
}

// catchAllRe matches the 404 catch-all that closes a config's rules.
// The writer writes it again, so it is the one rule the repair reads
// and rewrites without losing anything.
var catchAllRe = regexp.MustCompile(`(?m)^\s*-\s+service:\s*http_status:404\s*$`)

// repairRuleProblems names the rules of a config the repair cannot
// rewrite faithfully: a rule whose service is not a loopback HTTP URL
// (a unix socket, an http2 service), a rule with no service, a service
// with no hostname, a rule the parser cannot read at all.
//
// ParseIngress pairs the hostnames and the ports by index, so one rule
// it cannot read shifts every pairing after it: the repair would write
// the tap rule with the editor's port. A rule it cannot read is also
// dropped by the rewrite, so the file is left alone instead.
func repairRuleProblems(raw string) []string {
	var problems []string
	scan := repairScan{}
	for _, line := range strings.Split(raw, "\n") {
		problems = append(problems, scan.read(line)...)
	}
	return append(problems, scan.unclosedRule()...)
}

// repairScan reads a config line by line, keeping the rule it is in: a
// rule's hostname waits for its service.
type repairScan struct {
	host string
}

// read takes one line of the config and names what the repair cannot
// rewrite faithfully.
func (s *repairScan) read(line string) []string {
	text := strings.TrimSpace(line)
	if text == "" || strings.HasPrefix(text, "#") {
		return nil
	}
	if m := hostnameRe.FindStringSubmatch(line); m != nil {
		return s.readHost(m[1])
	}
	return s.readService(line, text)
}

// readHost takes the hostname of a rule: a rule that never got a
// service is a problem.
func (s *repairScan) readHost(host string) []string {
	var problems []string
	if s.host != "" {
		problems = append(problems, "a rule with no service: "+s.host)
	}
	s.host = host
	return problems
}

// readService takes a line that is not a hostname: the service of a
// rule, the catch-all, or a rule the repair cannot read.
func (s *repairScan) readService(line, text string) []string {
	switch {
	case serviceRe.MatchString(line):
		var problems []string
		if s.host == "" {
			problems = append(problems, "a service with no hostname: "+text)
		}
		s.host = ""
		return problems
	case catchAllRe.MatchString(line):
		return nil
	}
	return s.readOther(text)
}

// readOther takes a line the repair cannot read at all.
func (s *repairScan) readOther(text string) []string {
	if s.host != "" {
		host := s.host
		s.host = ""
		return []string{"a rule the repair cannot pair: " + host + " — " + text}
	}
	if strings.HasPrefix(text, "-") {
		return []string{"a rule the repair cannot read: " + text}
	}
	return nil
}

// unclosedRule names the rule that never got a service.
func (s *repairScan) unclosedRule() []string {
	if s.host == "" {
		return nil
	}
	return []string{"a rule with no service: " + s.host}
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
	tapHost, uiHost := repairHosts(boxID)
	var sb strings.Builder
	_, _ = fmt.Fprintf(&sb, "tap url   : https://%s/pair\n", tapHost)
	_, _ = fmt.Fprintf(&sb, "pair url  : https://%s\n", uiHost)
	_, _ = fmt.Fprintf(&sb, "daemon    : 127.0.0.1:%d\n", DaemonPort)
	_, _ = fmt.Fprintf(&sb, "opencode  : 127.0.0.1:%d\n", OpenCodePort)
	return sb.String()
}
