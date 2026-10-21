// Package onboard, tunnel half: Cloudflare tunnel + DNS provisioning for
// `ocd onboard`. The runner is os/exec against PATH so tests install a fake
// cloudflared; all parsing is defensive (unknown fields ignored).
package onboard

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// TunnelPlan describes the per-box tunnel. UIHost is optional: empty
// skips the UI hostname entirely.
type TunnelPlan struct {
	Name    string
	TapHost string
	UIHost  string
	CredDir string
	// Port serves the ocd daemon (pair links, box API).
	Port int
	// UIPort serves the OpenCode web UI. It is a different service from
	// the daemon, so the editor hostname must point at it — pointing it
	// at the daemon yields a UI host that serves 404.
	UIPort   int
	APIToken string
}

// DaemonPort is the ocd daemon's loopback port (pair links, box API).
const DaemonPort = 49400

// OpenCodePort is the OpenCode web UI's loopback port.
const OpenCodePort = 49374

// TapHost is the hostname serving this box's tap (pair) links.
func TapHost(boxID string) string {
	return "oc-tap-" + boxID + ".buyallmemes.com"
}

// UIHost is the hostname serving this box's editor UI.
func UIHost(boxID string) string {
	return "oc-" + boxID + ".buyallmemes.com"
}

// DefaultTunnelPlan derives the conventional names from a box id:
// oc-<box> tunnel, oc-tap-<box> tap host, oc-<box> UI host.
func DefaultTunnelPlan(boxID string) TunnelPlan {
	return TunnelPlan{
		Name:    "oc-" + boxID,
		TapHost: "oc-tap-" + boxID + ".buyallmemes.com",
		UIHost:  "oc-" + boxID + ".buyallmemes.com",
		Port:    DaemonPort,
		UIPort:  OpenCodePort,
	}
}

// TunnelDefaults fills blanks for the wizard: tunnel name oc-<box>, UI
// hostname derived from the tap host's domain (oc-<box>.<domain>).
// Bare hostnames get no UI default.
func TunnelDefaults(boxID, tapHost string) (name, ui string) {
	name = "oc-" + boxID
	if i := strings.Index(tapHost, "."); i > 0 {
		ui = "oc-" + boxID + tapHost[i:]
	}
	return name, ui
}

// DefaultCredDir mirrors cloudflared: ~/.cloudflared.
func DefaultCredDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("onboard: home dir: %w", err)
	}
	return filepath.Join(home, ".cloudflared"), nil
}

func cloudflared(ctx context.Context, apiToken string, args ...string) (string, error) {
	bin, err := exec.LookPath("cloudflared")
	if err != nil {
		return "", fmt.Errorf("onboard: cloudflared not found (brew install cloudflare/cloudflare/cloudflared): %w", err)
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	if apiToken != "" {
		cmd.Env = append(os.Environ(), "CLOUDFLARE_API_TOKEN="+apiToken)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		out := strings.TrimSpace(stderr.String() + " " + stdout.String())
		return "", fmt.Errorf("onboard: cloudflared %s: %v %s", strings.Join(args, " "), err, out)
	}
	return stdout.String(), nil
}

// ListTunnels returns tunnel name -> id from `cloudflared tunnel list`.
func ListTunnels(ctx context.Context) (map[string]string, error) {
	out, err := cloudflared(ctx, os.Getenv("CLOUDFLARE_API_TOKEN"), "tunnel", "list", "-o", "json")
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		return nil, fmt.Errorf("onboard: parse tunnel list: %w", err)
	}
	m := map[string]string{}
	for _, r := range rows {
		if r.Name != "" && r.ID != "" {
			m[r.Name] = r.ID
		}
	}
	return m, nil
}

var uuidRe = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)

// CreateTunnel creates a tunnel and returns its id (parsed from the
// credentials filename cloudflared reports).
func CreateTunnel(ctx context.Context, apiToken, name string) (string, error) {
	out, err := cloudflared(ctx, apiTokenOrEnv(apiToken), "tunnel", "create", name)
	if err != nil {
		return "", err
	}
	id := uuidRe.FindString(out)
	if id == "" {
		return "", fmt.Errorf("onboard: could not parse tunnel id from cloudflared output")
	}
	return id, nil
}

func apiTokenOrEnv(explicit string) string {
	if explicit != "" {
		return explicit
	}
	return os.Getenv("CLOUDFLARE_API_TOKEN")
}

// RouteDNS points hostname at the tunnel (creates/updates the CNAME).
//
// The record may already be there — the brain writes these records too,
// and a re-onboard routes them again. cloudflared refuses to create a
// record that exists, so the route overwrites it: without the flag the
// onboard aborts on a Cloudflare error the operator has no lever for.
func RouteDNS(ctx context.Context, apiToken, tunnel, hostname string) error {
	_, err := cloudflared(ctx, apiTokenOrEnv(apiToken), "tunnel", "route", "dns", "--overwrite-dns", tunnel, hostname)
	return err
}

// renderTunnelConfig is the whole config.yml content: tunnel identity plus
// the ingress rules, closed by a 404 catch-all.
func renderTunnelConfig(tunnelID, credFile string, rules []ingressRule) string {
	var sb strings.Builder
	_, _ = fmt.Fprintf(&sb, "tunnel: %s\ncredentials-file: %s\ningress:\n", tunnelID, credFile)
	for _, r := range rules {
		_, _ = fmt.Fprintf(&sb, "  - hostname: %s\n    service: http://127.0.0.1:%d\n", r.Hostname, r.Port)
	}
	_, _ = fmt.Fprintf(&sb, "  - service: http_status:404\n")
	return sb.String()
}

// The writer emits a fixed shape, and a rewrite reproduces only that
// shape: the tunnel identity, the ingress block, one hostname/service
// pair per rule, the 404 catch-all. A config that holds anything else —
// a rule the parser cannot read, an option under a rule, another
// top-level key — would lose it in a rewrite. The merge refuses those
// configs instead of dropping parts of them.
//
// writerLineRe matches a line the writer emits: a rule's hostname, a
// rule's local service, the 404 catch-all, or a top-level key. Its
// hostname and service patterns are the parser's own, so a line the
// parser cannot read is a line the writer cannot write.
var writerLineRe = regexp.MustCompile(`^\s*(?:` + hostnamePattern + `|` + servicePattern +
	`|-\s+service:\s*http_status:404|tunnel:\s*\S+|credentials-file:\s*\S+|ingress:)\s*$`)

// topLevelKeyRe matches a name at the start of a line: a top-level key.
var topLevelKeyRe = regexp.MustCompile(`^([A-Za-z_][A-Za-z0-9_.-]*):`)

// The groups of writerLineRe: the rule's hostname, the rule's port.
const (
	hostGroup = 1
	portGroup = 2
)

// unreproducibleParts lists what a tunnel config holds that a rewrite
// would drop: a line the writer does not emit, and a rule whose service
// does not follow it.
func unreproducibleParts(raw string) []string {
	var parts []string
	expectService := false
	host := ""
	for _, line := range strings.Split(raw, "\n") {
		text := strings.TrimSpace(line)
		if text == "" || strings.HasPrefix(text, "#") {
			continue
		}
		m := writerLineRe.FindStringSubmatch(line)
		if m == nil {
			parts = append(parts, unreproduciblePart(line))
			continue
		}
		if m[hostGroup] != "" {
			if expectService {
				parts = append(parts, "a rule with no service: "+host)
			}
			host = m[hostGroup]
			expectService = true
			continue
		}
		if m[portGroup] != "" {
			if !expectService {
				parts = append(parts, "a service with no hostname: "+text)
			}
			expectService = false
		}
	}
	if expectService {
		parts = append(parts, "a rule with no service: "+host)
	}
	return parts
}

// unreproduciblePart names what a line the writer does not emit holds.
func unreproduciblePart(line string) string {
	text := strings.TrimSpace(line)
	if !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") {
		if m := topLevelKeyRe.FindStringSubmatch(text); m != nil {
			return "the top-level key " + m[1]
		}
	}
	return "a rule the writer cannot reproduce: " + text
}

// EnsureTunnelConfig makes the box's tunnel config serve the desired
// rules: the conventional hosts first, then every rule the file already
// held, in the file's own order. The old names keep serving and a
// hand-added rule survives — the new config is a superset of the old one,
// never a replacement.
//
// The file's own identity is kept: the merge never re-points the box at
// another tunnel, and it refuses a config that holds something a rewrite
// would drop. A config that already serves the desired rules is reused,
// so a re-run writes nothing.
func EnsureTunnelConfig(path, tunnelID, credFile, tapHost, uiHost string, port, uiPort int) (reused bool, err error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			// A config we cannot read is a config we cannot merge: writing
			// over it would lose it.
			return false, fmt.Errorf("onboard: read tunnel config: %w — re-run with --skip-tunnel to reuse the existing config", err)
		}
		rules := desiredIngressRules(tapHost, uiHost, port, uiPort, nil)
		return false, writeTunnelConfig(path, renderTunnelConfig(tunnelID, credFile, rules))
	}
	rules, err := mergeableConfig(path, string(raw), tunnelID)
	if err != nil {
		return false, err
	}
	desired := desiredIngressRules(tapHost, uiHost, port, uiPort, rules)
	if sameIngressRules(rules, desired) {
		return true, nil
	}
	return false, writeTunnelConfig(path, renderTunnelConfig(tunnelID, configCredentials(string(raw), credFile), desired))
}

// notATunnelConfig names a file that cannot say which tunnel this box
// serves. The merge and the setup refuse it with the same words.
func notATunnelConfig(path string) error {
	return fmt.Errorf("onboard: %s is not a tunnel config — move it aside to regenerate, or re-run with --skip-tunnel", path)
}

// mergeableConfig reads the rules of a config the merge may rewrite: the
// file must serve the tunnel the caller named, and it must hold nothing
// the writer cannot reproduce.
func mergeableConfig(path, raw, tunnelID string) ([]ingressRule, error) {
	fileTunnel := configTunnelID(raw)
	if fileTunnel == "" {
		return nil, notATunnelConfig(path)
	}
	if fileTunnel != tunnelID {
		return nil, fmt.Errorf("onboard: %s serves tunnel %s, not %s — move it aside to regenerate, or re-run with --skip-tunnel", path, fileTunnel, tunnelID)
	}
	if parts := unreproducibleParts(raw); len(parts) > 0 {
		return nil, fmt.Errorf("onboard: %s holds %s — remove it, move the file aside to regenerate, or re-run with --skip-tunnel", path, strings.Join(parts, "; "))
	}
	return ParseIngress(raw), nil
}

// configTunnelID returns the tunnel id a config names, empty when it
// names none.
func configTunnelID(raw string) string {
	if m := tunnelIDRe.FindStringSubmatch(raw); m != nil {
		return m[1]
	}
	return ""
}

// configCredentials returns the credentials file a config names, or the
// fallback when it names none.
func configCredentials(raw, fallback string) string {
	if m := credFileRe.FindStringSubmatch(raw); m != nil {
		return m[1]
	}
	return fallback
}

func writeTunnelConfig(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("onboard: mkdir: %w", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return fmt.Errorf("onboard: write tunnel config: %w", err)
	}
	return nil
}

// EnsureCloudflaredLogin guarantees tunnel auth before provisioning: an
// existing login, an API token (flag or env), or — interactive only — a
// guided `cloudflared tunnel login` run. Never stores anything.
func EnsureCloudflaredLogin(ctx context.Context, credDir, apiToken string, interactive bool, w io.Writer) error {
	if HasCert(credDir) || strings.TrimSpace(apiToken) != "" || os.Getenv("CLOUDFLARE_API_TOKEN") != "" {
		return nil
	}
	if !interactive {
		return fmt.Errorf("onboard: no cloudflared login found — run `cloudflared tunnel login` or set CLOUDFLARE_API_TOKEN")
	}
	_, _ = fmt.Fprintln(w, "opening cloudflared login in your browser…")
	cmd := exec.CommandContext(ctx, "cloudflared", "tunnel", "login")
	cmd.Stdin = os.Stdin
	cmd.Stdout = w
	cmd.Stderr = w
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("onboard: cloudflared login failed: %w", err)
	}
	if !HasCert(credDir) {
		return fmt.Errorf("onboard: login did not produce credentials — rerun once finished")
	}
	return nil
}

// (cert.pem present). dir is explicit so tests stay hermetic; production
// passes the cloudflared home holding config.yml.
func HasCert(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "cert.pem"))
	return err == nil
}

// SetupTunnel resolves the tunnel this box serves, writes config.yml and
// routes the DNS for the tap (+UI) host. Progress mirrors DoOnboard:
// nil-safe.
//
// The box's own config names the tunnel the box serves, and that id is
// the box's — whatever the plan calls the tunnel. The name is a label,
// the id is the identity, so a box never ends up with a second tunnel.
//
// The DNS is routed every time: the records may be missing (the brain
// writes them too), and the route overwrites, so running it again
// changes nothing.
func SetupTunnel(ctx context.Context, plan TunnelPlan, progress func(string)) (string, error) {
	say := func(s string) {
		if progress != nil {
			progress(s)
		}
	}
	if strings.TrimSpace(plan.TapHost) == "" {
		return "", fmt.Errorf("onboard: tap hostname is required")
	}
	if plan.Port <= 0 {
		plan.Port = DaemonPort
	}
	if plan.UIPort <= 0 {
		plan.UIPort = OpenCodePort
	}
	if strings.TrimSpace(plan.CredDir) == "" {
		dir, err := DefaultCredDir()
		if err != nil {
			return "", err
		}
		plan.CredDir = dir
	}
	if !HasCert(plan.CredDir) && strings.TrimSpace(plan.APIToken) == "" && os.Getenv("CLOUDFLARE_API_TOKEN") == "" {
		return "", fmt.Errorf("onboard: no cloudflared login found — run `cloudflared tunnel login` or provide a CLOUDFLARE_API_TOKEN")
	}
	cfgPath := filepath.Join(plan.CredDir, "config.yml")
	id, err := resolveTunnelID(ctx, plan, cfgPath, say)
	if err != nil {
		return "", err
	}
	credFile := filepath.Join(plan.CredDir, id+".json")
	reused, err := EnsureTunnelConfig(cfgPath, id, credFile, plan.TapHost, plan.UIHost, plan.Port, plan.UIPort)
	if err != nil {
		return "", err
	}
	if reused {
		say("reusing tunnel config " + cfgPath)
	} else {
		say("writing " + cfgPath)
	}
	if err := routeBoxDNS(ctx, plan, id, say); err != nil {
		return "", err
	}
	return id, nil
}

// resolveTunnelID resolves the tunnel id this box serves.
//
// The box's own config names it, and that id wins whatever the plan calls
// the tunnel: the name is a label, the id is the identity. So a box whose
// config names a tunnel never creates a second one — the old names' DNS
// keeps pointing at the tunnel the box actually runs.
//
// Only a box with no config of its own looks the plan's name up, and
// creates the tunnel when the name is unknown.
func resolveTunnelID(ctx context.Context, plan TunnelPlan, cfgPath string, say func(string)) (string, error) {
	own, err := ownTunnelID(cfgPath)
	if err != nil {
		return "", err
	}
	if own != "" {
		say(tunnelChoice(own, plan.Name))
		return own, nil
	}
	say("listing tunnels")
	existing, err := ListTunnels(ctx)
	if err != nil {
		return "", err
	}
	if id := existing[plan.Name]; id != "" {
		say("reusing tunnel " + plan.Name)
		return id, nil
	}
	say("creating tunnel " + plan.Name)
	return CreateTunnel(ctx, plan.APIToken, plan.Name)
}

// ownTunnelID returns the tunnel id the box's own config names.
//
// Empty when the box has no config of its own — that box may create a
// tunnel. A config that exists but names no tunnel is refused: the box
// has a config, and creating a tunnel behind it would leave the box with
// two.
func ownTunnelID(cfgPath string) (string, error) {
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		// A config we cannot read is a config we cannot learn the box's
		// tunnel from, and writing over it would lose it.
		return "", fmt.Errorf("onboard: read tunnel config: %w — re-run with --skip-tunnel to reuse the existing config", err)
	}
	id := configTunnelID(string(raw))
	if id == "" {
		return "", notATunnelConfig(cfgPath)
	}
	return id, nil
}

// tunnelChoice says which tunnel the box serves and why: its own config
// names it, whatever the plan calls the tunnel.
func tunnelChoice(id, planName string) string {
	if planName == "" {
		return "reusing the box's own tunnel " + id
	}
	return "reusing the box's own tunnel " + id + " (the plan calls it " + planName + ")"
}

// routeBoxDNS points the box's hosts at its tunnel.
//
// The records may be missing — the brain writes them too, and a box set
// up before the brain owned the DNS has none. The route overwrites, so
// running it again changes nothing.
func routeBoxDNS(ctx context.Context, plan TunnelPlan, tunnelID string, say func(string)) error {
	say("routing DNS " + plan.TapHost)
	if err := RouteDNS(ctx, plan.APIToken, tunnelID, plan.TapHost); err != nil {
		return err
	}
	uiHost := strings.TrimSpace(plan.UIHost)
	if uiHost == "" {
		return nil
	}
	say("routing DNS " + uiHost)
	return RouteDNS(ctx, plan.APIToken, tunnelID, uiHost)
}
