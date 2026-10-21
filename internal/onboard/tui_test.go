package onboard_test

import (
	"strings"
	"testing"

	"github.com/mfenderov/ocd/internal/onboard"
)

// The closing panel names the tunnel by its id: the name is a label,
// and a rename must never be able to stop the box.
func TestRenderResultNamesTheTunnelByItsId(t *testing.T) {
	var sb strings.Builder
	cfg := onboard.Config{BoxID: "home", Tunnel: &onboard.TunnelPlan{Name: "oc-home"}}
	res := onboard.Result{TunnelID: "7ed965a2-9828-46f6-851e-24cf1b9fedf6"}

	onboard.RenderResult(&sb, cfg, res, false)

	got := sb.String()
	if !strings.Contains(got, "7ed965a2-9828-46f6-851e-24cf1b9fedf6") {
		t.Fatalf("the panel must name the tunnel by its id, got:\n%s", got)
	}
	if strings.Contains(got, "oc-home") {
		t.Fatalf("the panel must not name the tunnel by its name, got:\n%s", got)
	}
}

// The panel must not tell the operator to start a connector: the box's
// own service runs it, and a second connector is what this must never
// produce.
func TestRenderResultDoesNotStartASecondConnector(t *testing.T) {
	var sb strings.Builder
	cfg := onboard.Config{BoxID: "home", Tunnel: &onboard.TunnelPlan{Name: "oc-home"}}
	res := onboard.Result{TunnelID: "7ed965a2-9828-46f6-851e-24cf1b9fedf6"}

	onboard.RenderResult(&sb, cfg, res, false)

	if strings.Contains(sb.String(), "cloudflared tunnel run") {
		t.Fatalf("the panel must not start a second connector, got:\n%s", sb.String())
	}
}

// A box whose daemon runs the connector says so: the operator must not
// start one by hand.
func TestRenderResultSaysTheDaemonRunsTheConnector(t *testing.T) {
	var sb strings.Builder
	cfg := onboard.Config{BoxID: "home", Tunnel: &onboard.TunnelPlan{Name: "oc-home"}}
	res := onboard.Result{TunnelID: "7ed965a2-9828-46f6-851e-24cf1b9fedf6", DaemonRunsTunnel: true}

	onboard.RenderResult(&sb, cfg, res, false)

	if !strings.Contains(sb.String(), "daemon runs the connector") {
		t.Fatalf("the panel must say who runs the connector, got:\n%s", sb.String())
	}
}

// A daemon the platform's own service runs is supervised: the panel
// must not tell the operator to start a second one.
func TestRenderResultDoesNotStartASecondDaemon(t *testing.T) {
	var sb strings.Builder
	cfg := onboard.Config{BoxID: "home", Tunnel: &onboard.TunnelPlan{Name: "oc-home"}}
	res := onboard.Result{
		TunnelID: "7ed965a2-9828-46f6-851e-24cf1b9fedf6",
		Restart:  onboard.RestartResult{DaemonRunsAsService: true},
	}

	onboard.RenderResult(&sb, cfg, res, false)

	if strings.Contains(sb.String(), "ocd serve") {
		t.Fatalf("the panel must not start a second daemon, got:\n%s", sb.String())
	}
}

// A daemon no service runs is the operator's to start: the panel says
// so.
func TestRenderResultSaysToStartTheDaemonWhenNoServiceRunsIt(t *testing.T) {
	var sb strings.Builder
	cfg := onboard.Config{BoxID: "home", Tunnel: &onboard.TunnelPlan{Name: "oc-home"}}
	res := onboard.Result{TunnelID: "7ed965a2-9828-46f6-851e-24cf1b9fedf6"}

	onboard.RenderResult(&sb, cfg, res, false)

	if !strings.Contains(sb.String(), "ocd serve") {
		t.Fatalf("the panel must say how to start the daemon, got:\n%s", sb.String())
	}
}
