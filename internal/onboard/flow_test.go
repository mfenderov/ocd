package onboard_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mfenderov/ocd/internal/onboard"
)

// restartCall is what the onboarding asked the machine to do.
type restartCall struct {
	tunnelID         string
	daemonRunsTunnel bool
}

// fakeRestartBox stands in for the machine: the onboarding asks it to
// bring the box back up, and no test restarts a daemon or a tunnel.
func fakeRestartBox(t *testing.T) *[]restartCall {
	t.Helper()
	calls := new([]restartCall)
	old := onboard.RestartBox
	onboard.RestartBox = func(_ context.Context, tunnelID string, daemonRunsTunnel bool) onboard.RestartResult {
		*calls = append(*calls, restartCall{tunnelID: tunnelID, daemonRunsTunnel: daemonRunsTunnel})
		return onboard.RestartResult{DaemonRunsAsService: true}
	}
	t.Cleanup(func() { onboard.RestartBox = old })
	return calls
}

// onboardServer answers the enrolment the way the brain does.
func onboardServer(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"enrolled","id":"home"}`))
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// plantOwnTunnelConfig writes the tunnel config a box that already
// serves a tunnel has: it names the tunnel the box serves.
func plantOwnTunnelConfig(t *testing.T, credDir, tunnelID string) {
	t.Helper()
	if err := os.MkdirAll(credDir, 0o700); err != nil {
		t.Fatal(err)
	}
	body := "tunnel: " + tunnelID + "\n" +
		"credentials-file: " + filepath.Join(credDir, tunnelID+".json") + "\n" +
		"ingress:\n" +
		"  - hostname: oc-tap-home.buyallmemes.com\n    service: http://127.0.0.1:49400\n" +
		"  - service: http_status:404\n"
	if err := os.WriteFile(filepath.Join(credDir, "config.yml"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// homeOnboard is the onboarding of the box "home", whose tunnel config
// lives in credDir.
func homeOnboard(t *testing.T, dir, credDir string) onboard.Config {
	t.Helper()
	plan := onboard.DefaultTunnelPlan("home")
	plan.CredDir = credDir
	plan.APIToken = "test-token" // no cloudflared login needed
	return onboard.Config{
		BoxID: "home", WorkerURL: onboardServer(t), PublicHost: onboard.TapHost("home"),
		PairURL: "https://" + onboard.UIHost("home"),
		Tunnel:  &plan,
		EnvPath: filepath.Join(dir, "env"), DBPath: filepath.Join(dir, "ocd.db"),
		Timeout: 10 * time.Second, PollInterval: time.Millisecond,
	}
}

// The box must come back up with what the onboarding just wrote: the
// connector must load the new ingress rules and the daemon the new env
// file. The tunnel is named by its id, the name is a label.
func TestOnboardingBringsTheBoxBackUp(t *testing.T) {
	const tunnelID = "7ed965a2-9828-46f6-851e-24cf1b9fedf6"
	dir := t.TempDir()
	credDir := filepath.Join(dir, ".cloudflared")
	plantOwnTunnelConfig(t, credDir, tunnelID)
	fakeCloudflared(t, map[string]string{"tunnel route": "Added CNAME"}, nil)
	calls := fakeRestartBox(t)

	cfg := homeOnboard(t, dir, credDir)
	if _, err := onboard.DoOnboard(context.Background(), cfg, nil); err != nil {
		t.Fatalf("onboard: %v", err)
	}
	if len(*calls) != 1 {
		t.Fatalf("the box must be brought back up once, got %d", len(*calls))
	}
	got := (*calls)[0]
	if got.tunnelID != tunnelID {
		t.Fatalf("the tunnel must be named by its id, got %q", got.tunnelID)
	}
	if got.daemonRunsTunnel {
		t.Fatal("the box's own service runs the connector, the daemon must not")
	}
}

// A run that reused the box's own tunnel must not make the daemon run
// the connector: the box's own service already does, and a second
// connector is what this must never produce.
func TestOnboardingThatReusedTheTunnelLeavesTheConnectorAlone(t *testing.T) {
	dir := t.TempDir()
	credDir := filepath.Join(dir, ".cloudflared")
	plantOwnTunnelConfig(t, credDir, "7ed965a2-9828-46f6-851e-24cf1b9fedf6")
	fakeCloudflared(t, map[string]string{"tunnel route": "Added CNAME"}, nil)
	fakeRestartBox(t)

	cfg := homeOnboard(t, dir, credDir)
	if _, err := onboard.DoOnboard(context.Background(), cfg, nil); err != nil {
		t.Fatalf("onboard: %v", err)
	}
	vals, err := onboard.LoadEnvFile(cfg.EnvPath)
	if err != nil {
		t.Fatalf("env: %v", err)
	}
	if vals["OCD_MANAGE_TUNNEL"] != "" {
		t.Fatalf("the daemon must not run the connector, got %q", vals["OCD_MANAGE_TUNNEL"])
	}
}

// A box that already had the key keeps it: the env file is merged, and
// a re-onboarding must not take the connector away from the daemon.
func TestOnboardingKeepsTheManageTunnelKeyTheBoxAlreadyHad(t *testing.T) {
	dir := t.TempDir()
	credDir := filepath.Join(dir, ".cloudflared")
	plantOwnTunnelConfig(t, credDir, "7ed965a2-9828-46f6-851e-24cf1b9fedf6")
	fakeCloudflared(t, map[string]string{"tunnel route": "Added CNAME"}, nil)
	fakeRestartBox(t)

	cfg := homeOnboard(t, dir, credDir)
	if err := os.WriteFile(cfg.EnvPath, []byte("OCD_MANAGE_TUNNEL=\"1\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := onboard.DoOnboard(context.Background(), cfg, nil); err != nil {
		t.Fatalf("onboard: %v", err)
	}
	vals, err := onboard.LoadEnvFile(cfg.EnvPath)
	if err != nil {
		t.Fatalf("env: %v", err)
	}
	if vals["OCD_MANAGE_TUNNEL"] != "1" {
		t.Fatalf("the key the box already had must survive, got %q", vals["OCD_MANAGE_TUNNEL"])
	}
}

// A run that created the tunnel owns it: nothing else runs that
// connector, so the daemon must.
func TestOnboardingThatCreatedTheTunnelMakesTheDaemonRunIt(t *testing.T) {
	dir := t.TempDir()
	credDir := filepath.Join(dir, ".cloudflared")
	fakeCloudflared(t, map[string]string{
		"tunnel list":   `[]`,
		"tunnel create": "Created tunnel oc-home with id 11111111-2222-3333-4444-555555555555",
		"tunnel route":  "Added CNAME",
	}, nil)
	calls := fakeRestartBox(t)

	cfg := homeOnboard(t, dir, credDir)
	if _, err := onboard.DoOnboard(context.Background(), cfg, nil); err != nil {
		t.Fatalf("onboard: %v", err)
	}
	vals, err := onboard.LoadEnvFile(cfg.EnvPath)
	if err != nil {
		t.Fatalf("env: %v", err)
	}
	if vals["OCD_MANAGE_TUNNEL"] != "1" {
		t.Fatalf("the daemon must run a connector nobody else runs, got %q", vals["OCD_MANAGE_TUNNEL"])
	}
	if len(*calls) != 1 || !(*calls)[0].daemonRunsTunnel {
		t.Fatalf("the daemon must be told it runs the connector, got %v", *calls)
	}
}

// The notices name what did not happen: the enrolment is committed, but
// the operator must know the box still runs the old config.
func TestOnboardingReportsARestartThatCouldNotHappen(t *testing.T) {
	dir := t.TempDir()
	credDir := filepath.Join(dir, ".cloudflared")
	plantOwnTunnelConfig(t, credDir, "7ed965a2-9828-46f6-851e-24cf1b9fedf6")
	fakeCloudflared(t, map[string]string{"tunnel route": "Added CNAME"}, nil)
	old := onboard.RestartBox
	onboard.RestartBox = func(context.Context, string, bool) onboard.RestartResult {
		return onboard.RestartResult{Notices: []string{"the daemon was not restarted: no service runs it"}}
	}
	t.Cleanup(func() { onboard.RestartBox = old })

	cfg := homeOnboard(t, dir, credDir)
	res, err := onboard.DoOnboard(context.Background(), cfg, nil)
	if err != nil {
		t.Fatalf("a restart that cannot happen must not fail the enrolment: %v", err)
	}
	if len(res.Restart.Notices) != 1 || !strings.Contains(res.Restart.Notices[0], "daemon was not restarted") {
		t.Fatalf("the notice must reach the caller, got %v", res.Restart.Notices)
	}
}
