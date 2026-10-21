package onboard_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mfenderov/ocd/internal/onboard"
)

// The repair fixes the wiring of a box an older build wired up wrongly:
// the env file holds the derived values.
func TestRepairFixesTheWiringOfTheBox(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("OCD_DB", filepath.Join(home, ".ocd", "ocd.db"))
	envPath := filepath.Join(home, ".ocd", "env")
	if err := os.MkdirAll(filepath.Dir(envPath), 0o700); err != nil {
		t.Fatal(err)
	}
	old := "OCD_BOX_ID=\"mac\"\n" +
		"OCD_PUBLIC_URL=\"https://oc-tap-mac.buyallmemes.com\"\n" +
		"OCD_PAIR_URL=\"https://oc-tap-mac.buyallmemes.com\"\n"
	if err := os.WriteFile(envPath, []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}

	res, err := onboard.Repair("mac")
	if err != nil {
		t.Fatalf("repair: %v", err)
	}
	if len(res.EnvChanged) == 0 {
		t.Fatal("the repair must report what it changed")
	}
	if res.TunnelFixed {
		t.Fatal("a box without a tunnel config has nothing to fix")
	}
	vals, err := onboard.LoadEnvFile(envPath)
	if err != nil {
		t.Fatalf("env: %v", err)
	}
	if vals["OCD_PUBLIC_URL"] != "https://oc-tap-mac.buyallmemes.com/pair" {
		t.Fatalf("the tap url must be fixed, got %q", vals["OCD_PUBLIC_URL"])
	}
	if vals["OCD_PAIR_URL"] != "https://oc-mac.buyallmemes.com" {
		t.Fatalf("the pair url must be fixed, got %q", vals["OCD_PAIR_URL"])
	}
}

// The summary names the values a box serves: the operator reads them
// when the wiring is wrong.
func TestEnvSummaryShowsTheDerivedValues(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	got := onboard.EnvSummary("mac")

	for _, want := range []string{
		"tap url   : https://oc-tap-mac.buyallmemes.com/pair",
		"pair url  : https://oc-mac.buyallmemes.com",
		"daemon    : 127.0.0.1:49400",
		"opencode  : 127.0.0.1:49374",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("the summary must hold %q, got:\n%s", want, got)
		}
	}
}

// The identity names what this box is and the URLs it serves: it is
// what `ocd` reports on a box that is already in the fleet.
func TestRenderIdentityShowsWhatTheBoxIs(t *testing.T) {
	var sb strings.Builder
	id := onboard.Identity{
		BoxID:     "home",
		TapURL:    "https://oc-tap-home.buyallmemes.com/pair",
		UIURL:     "https://oc-home.buyallmemes.com",
		WorkerURL: "https://ocd-fleet.fenderovlol.workers.dev",
	}

	onboard.RenderIdentity(&sb, id)

	got := sb.String()
	for _, want := range []string{"home", id.TapURL, id.UIURL, id.WorkerURL, "/link"} {
		if !strings.Contains(got, want) {
			t.Fatalf("the identity must hold %q, got:\n%s", want, got)
		}
	}
}

// A plan without a credentials directory uses the cloudflared home: the
// box keeps its tunnel where cloudflared keeps it.
func TestSetupTunnelUsesTheCloudflaredHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	recordingCloudflared(t, map[string]string{
		"tunnel list":   `[]`,
		"tunnel create": "Created tunnel oc-mac with id aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		"tunnel route":  `Added CNAME oc-tap-mac.buyallmemes.com to oc-mac`,
	}, nil)
	credDir := filepath.Join(home, ".cloudflared")
	if err := os.MkdirAll(credDir, 0o700); err != nil {
		t.Fatal(err)
	}
	plantCert(t, credDir)
	plan := onboard.TunnelPlan{
		Name: "oc-mac", TapHost: "oc-tap-mac.buyallmemes.com", APIToken: "test-token",
	}

	setup, err := onboard.SetupTunnel(context.Background(), plan, func(string) {})
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	if setup.ID != "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" {
		t.Fatalf("want the created tunnel, got %q", setup.ID)
	}
	if _, err := os.Stat(filepath.Join(credDir, "config.yml")); err != nil {
		t.Fatalf("the config must be written to the cloudflared home: %v", err)
	}
}

// fakeCloudflaredLogin installs a stub cloudflared that stands in for
// the browser login: it writes the credentials the real one writes.
func fakeCloudflaredLogin(t *testing.T, body string) {
	t.Helper()
	dir := t.TempDir()
	script := "#!/bin/sh\n" + body
	//nolint:gosec // the stub binary must be executable: it stands in for a real one.
	if err := os.WriteFile(filepath.Join(dir, "cloudflared"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
}

// The login must produce credentials: without them the tunnel cannot be
// created.
func TestEnsureCloudflaredLoginGuidesTheBrowser(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLOUDFLARE_API_TOKEN", "")
	credDir := filepath.Join(home, ".cloudflared")
	if err := os.MkdirAll(credDir, 0o700); err != nil {
		t.Fatal(err)
	}
	fakeCloudflaredLogin(t, "mkdir -p \"$HOME/.cloudflared\"\necho cert > \"$HOME/.cloudflared/cert.pem\"\n")

	var sb strings.Builder
	if err := onboard.EnsureCloudflaredLogin(context.Background(), credDir, "", true, &sb); err != nil {
		t.Fatalf("login: %v", err)
	}
	if !strings.Contains(sb.String(), "opening cloudflared login") {
		t.Fatalf("the operator must be told what happens, got:\n%s", sb.String())
	}
	if !onboard.HasCert(credDir) {
		t.Fatal("the login must leave the credentials behind")
	}
}

// A login that fails must say so: the operator has to know the tunnel
// cannot be set up yet.
func TestEnsureCloudflaredLoginReportsAFailedLogin(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLOUDFLARE_API_TOKEN", "")
	credDir := filepath.Join(home, ".cloudflared")
	fakeCloudflaredLogin(t, "echo 'login failed' >&2\nexit 1\n")

	var sb strings.Builder
	err := onboard.EnsureCloudflaredLogin(context.Background(), credDir, "", true, &sb)
	if err == nil {
		t.Fatal("a failed login must be reported")
	}
	if !strings.Contains(err.Error(), "cloudflared login failed") {
		t.Fatalf("the error must name the failed login, got %v", err)
	}
}

// A login that produces nothing must say so: the tunnel needs the
// credentials.
func TestEnsureCloudflaredLoginReportsAMissingCert(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLOUDFLARE_API_TOKEN", "")
	credDir := filepath.Join(home, ".cloudflared")
	fakeCloudflaredLogin(t, "exit 0\n")

	var sb strings.Builder
	err := onboard.EnsureCloudflaredLogin(context.Background(), credDir, "", true, &sb)
	if err == nil {
		t.Fatal("a login without credentials must be reported")
	}
	if !strings.Contains(err.Error(), "did not produce credentials") {
		t.Fatalf("the error must name the missing credentials, got %v", err)
	}
}

// Without a terminal there is nobody to click through the login: the
// operator must be told what to do.
func TestEnsureCloudflaredLoginRefusesWithoutATerminal(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLOUDFLARE_API_TOKEN", "")
	credDir := filepath.Join(home, ".cloudflared")

	var sb strings.Builder
	err := onboard.EnsureCloudflaredLogin(context.Background(), credDir, "", false, &sb)
	if err == nil {
		t.Fatal("a box without a terminal must be refused")
	}
	if !strings.Contains(err.Error(), "no cloudflared login found") {
		t.Fatalf("the error must name the missing login, got %v", err)
	}
}
