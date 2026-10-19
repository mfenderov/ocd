package onboard_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mfenderov/ocd/internal/onboard"
)

// fakeCloudflared installs an executable stub answering canned outputs.
// handlers maps "tunnel list" style subcommand keys to stdout; fail maps
// keys to a failing exit.
func fakeCloudflared(t *testing.T, handlers map[string]string, fail map[string]bool) string {
	t.Helper()
	dir := t.TempDir()
	script := "#!/bin/sh\nkey=\"$1 $2\"\n" +
		"case \"$key\" in\n"
	for k, out := range handlers {
		script += "  \"" + k + "\") printf '%s' '" + out + "';;\n"
	}
	script += "esac\n"
	for k := range fail {
		script += `if [ "$key" = "` + k + `" ]; then exit 1; fi` + "\n"
	}
	script += "exit 0\n"
	p := filepath.Join(dir, "cloudflared")
	if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	return dir
}

const listJSON = `[{"id":"11111111-2222-3333-4444-555555555555","name":"oc-mac","created_at":"2026-10-19T00:00:00Z","deleted_at":"0001-01-01T00:00:00Z","connections":[]}]`

func plantCert(t *testing.T, dir string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "cert.pem"), []byte("fake-cert"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLOUDFLARE_API_TOKEN", "")
}

func TestListTunnelsParsesNames(t *testing.T) {
	fakeCloudflared(t, map[string]string{"tunnel list": listJSON}, nil)
	got, err := onboard.ListTunnels(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if got["oc-mac"] != "11111111-2222-3333-4444-555555555555" {
		t.Fatalf("want id for oc-mac, got %v", got)
	}
}

func TestSetupTunnelFullFlow(t *testing.T) {
	fakeCloudflared(t, map[string]string{
		"tunnel list":   `[]`,
		"tunnel create": "Created tunnel oc-mac with id aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\nTunnel credentials written to /tmp/x/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json",
		"tunnel route":  `Added CNAME oc-tap-mac.buyallmemes.com to oc-mac`,
	}, nil)
	dir := t.TempDir()
	plantCert(t, dir)
	plan := onboard.TunnelPlan{
		Name: "oc-mac", TapHost: "oc-tap-mac.buyallmemes.com", UIHost: "",
		CredDir: dir, Port: 49400,
	}
	id, err := onboard.SetupTunnel(context.Background(), plan, func(string) {})
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	if id != "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" {
		t.Fatalf("want parsed tunnel id, got %q", id)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "config.yml"))
	if err != nil {
		t.Fatalf("config not written: %v", err)
	}
	for _, want := range []string{"oc-tap-mac.buyallmemes.com", "49400", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("config must contain %q, got:\n%s", want, raw)
		}
	}
}

func TestSetupTunnelReusesExisting(t *testing.T) {
	fakeCloudflared(t, map[string]string{"tunnel list": listJSON}, nil)
	dir := t.TempDir()
	plantCert(t, dir)
	plan := onboard.TunnelPlan{
		Name: "oc-mac", TapHost: "oc-tap-mac.buyallmemes.com",
		CredDir: dir, Port: 49400,
	}
	id, err := onboard.SetupTunnel(context.Background(), plan, func(string) {})
	if err != nil {
		t.Fatalf("reuse: %v", err)
	}
	if id != "11111111-2222-3333-4444-555555555555" {
		t.Fatalf("must reuse existing tunnel, got %q", id)
	}
}

func TestSetupTunnelRefusesToClobberConfig(t *testing.T) {
	fakeCloudflared(t, map[string]string{"tunnel list": `[]`, "tunnel create": "id 99999999-0000-0000-0000-000000000000"}, nil)
	dir := t.TempDir()
	plantCert(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "config.yml"), []byte("existing"), 0o600); err != nil {
		t.Fatal(err)
	}
	plan := onboard.TunnelPlan{Name: "oc-x", TapHost: "oc-tap-x.buyallmemes.com", CredDir: dir, Port: 49400}
	if _, err := onboard.SetupTunnel(context.Background(), plan, func(string) {}); err == nil {
		t.Fatal("must not overwrite an existing config.yml")
	}
}

func TestTunnelDefaults(t *testing.T) {
	name, ui := onboard.TunnelDefaults("mac", "oc-tap-mac.buyallmemes.com")
	if name != "oc-mac" {
		t.Fatalf("tunnel name = %q", name)
	}
	if ui != "oc-mac.buyallmemes.com" {
		t.Fatalf("ui host = %q", ui)
	}
	if _, ui2 := onboard.TunnelDefaults("mac", "localhost"); ui2 != "" {
		t.Fatalf("bare hostnames get no UI default, got %q", ui2)
	}
}

func TestSetupTunnelRequiresLoginOrToken(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLOUDFLARE_API_TOKEN", "")
	plan := onboard.TunnelPlan{Name: "oc-x", TapHost: "oc-tap-x.example.com", CredDir: dir, Port: 49400}
	if _, err := onboard.SetupTunnel(context.Background(), plan, nil); err == nil {
		t.Fatal("must refuse without login or API token")
	}
}

func TestSetupTunnelReusesIdenticalConfig(t *testing.T) {
	fakeCloudflared(t, map[string]string{
		"tunnel list":   `[]`,
		"tunnel create": "Created tunnel oc-dup with id 11111111-1111-1111-1111-111111111111",
		"tunnel route":  `Added CNAME`,
	}, nil)
	dir := t.TempDir()
	plantCert(t, dir)
	plan := onboard.TunnelPlan{Name: "oc-dup", TapHost: "oc-tap-dup.example.com", CredDir: dir, Port: 49400}
	if _, err := onboard.SetupTunnel(context.Background(), plan, nil); err != nil {
		t.Fatalf("first setup: %v", err)
	}
	id, err := onboard.SetupTunnel(context.Background(), plan, nil)
	if err != nil {
		t.Fatalf("identical rerun must pass through, got: %v", err)
	}
	if id != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("want same tunnel id, got %q", id)
	}
}
