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
func RouteDNS(ctx context.Context, apiToken, tunnel, hostname string) error {
	_, err := cloudflared(ctx, apiTokenOrEnv(apiToken), "tunnel", "route", "dns", tunnel, hostname)
	return err
}

// renderTunnelConfig is the whole config.yml content: tunnel identity plus
// one ingress rule per hostname, closed by a 404 catch-all.
func renderTunnelConfig(tunnelID, credFile, tapHost, uiHost string, port, uiPort int) string {
	var sb strings.Builder
	_, _ = fmt.Fprintf(&sb, "tunnel: %s\ncredentials-file: %s\ningress:\n", tunnelID, credFile)
	_, _ = fmt.Fprintf(&sb, "  - hostname: %s\n    service: http://127.0.0.1:%d\n", tapHost, port)
	if strings.TrimSpace(uiHost) != "" {
		_, _ = fmt.Fprintf(&sb, "  - hostname: %s\n    service: http://127.0.0.1:%d\n", strings.TrimSpace(uiHost), uiPort)
	}
	_, _ = fmt.Fprintf(&sb, "  - service: http_status:404\n")
	return sb.String()
}

// WriteTunnelConfig renders config.yml. Refuses to overwrite an existing
// file: tunnel config is hand-tuned infrastructure, never silently replaced.
// Use EnsureTunnelConfig when reruns should pass through unchanged files.
func WriteTunnelConfig(path, tunnelID, credFile, tapHost, uiHost string, port, uiPort int) error {
	if _, err := os.Stat(path); err == nil {
		return fmt.Errorf("onboard: %s exists — move it aside to regenerate", path)
	}
	return writeTunnelConfig(path, renderTunnelConfig(tunnelID, credFile, tapHost, uiHost, port, uiPort))
}

// EnsureTunnelConfig writes config.yml unless an identical one is already
// there (re-runs pass through silently). A differing file still refuses:
// pass --skip-tunnel to reuse existing infra untouched.
func EnsureTunnelConfig(path, tunnelID, credFile, tapHost, uiHost string, port, uiPort int) (reused bool, err error) {
	want := renderTunnelConfig(tunnelID, credFile, tapHost, uiHost, port, uiPort)
	if raw, err := os.ReadFile(path); err == nil {
		if string(raw) == want {
			return true, nil
		}
		return false, fmt.Errorf("onboard: %s differs — move it aside to regenerate, or re-run with --skip-tunnel", path)
	}
	return false, writeTunnelConfig(path, want)
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

// SetupTunnel creates (or reuses) the tunnel, routes DNS for tap (+UI),
// and writes config.yml. Progress mirrors DoOnboard: nil-safe.
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
	say("listing tunnels")
	existing, err := ListTunnels(ctx)
	if err != nil {
		return "", err
	}
	id := existing[plan.Name]
	if id == "" {
		say("creating tunnel " + plan.Name)
		id, err = CreateTunnel(ctx, plan.APIToken, plan.Name)
		if err != nil {
			return "", err
		}
	} else {
		say("reusing tunnel " + plan.Name)
	}
	cfgPath := filepath.Join(plan.CredDir, "config.yml")
	credFile := filepath.Join(plan.CredDir, id+".json")
	reused, err := EnsureTunnelConfig(cfgPath, id, credFile, plan.TapHost, plan.UIHost, plan.Port, plan.UIPort)
	if err != nil {
		return "", err
	}
	if reused {
		say("reusing tunnel config")
		return id, nil
	}
	say("writing " + cfgPath)
	say("routing DNS " + plan.TapHost)
	if err := RouteDNS(ctx, plan.APIToken, id, plan.TapHost); err != nil {
		return "", err
	}
	if strings.TrimSpace(plan.UIHost) != "" {
		say("routing DNS " + strings.TrimSpace(plan.UIHost))
		if err := RouteDNS(ctx, plan.APIToken, id, strings.TrimSpace(plan.UIHost)); err != nil {
			return "", err
		}
	}
	return id, nil
}
