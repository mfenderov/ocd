package cli

import (
	"io"
	"testing"

	"github.com/mfenderov/ocd/internal/onboard"
)

// The tunnel needs the cloudflared credentials directory, and that
// directory needs the home directory. Without it the onboarding must say
// so: a tunnel whose login was never ensured is a tunnel nobody can
// create.
func TestTunnelPlanRefusesWithoutAHomeDirectory(t *testing.T) {
	t.Setenv("HOME", "")
	t.Setenv("OCD_MANAGE_TUNNEL", "")

	_, err := tunnelPlan(t.Context(), io.Discard, onboard.Options{},
		"mac", "oc-tap-mac.example.com", "oc-mac.example.com", 49400)
	if err == nil {
		t.Fatal("want an error without a home directory, got nil")
	}
}

// The tunnel a box serves is named after the box — oc-<box> — and
// answers on the conventional hosts: the tap host serves the daemon,
// the UI host serves the editor. The name is only a label, but it is
// the label the operator sees in `cloudflared tunnel list`.
func TestTunnelPlanNamesTheTunnelAfterTheBox(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CLOUDFLARE_API_TOKEN", "test-token") // no cloudflared login needed

	plan, err := tunnelPlan(t.Context(), io.Discard, onboard.Options{},
		"mac", onboard.TapHost("mac"), onboard.UIHost("mac"), onboard.OpenCodePort)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if plan.Name != "oc-mac" {
		t.Fatalf("tunnel name = %q", plan.Name)
	}
	if plan.TapHost != "oc-tap-mac.buyallmemes.com" {
		t.Fatalf("tap host = %q", plan.TapHost)
	}
	if plan.UIHost != "oc-mac.buyallmemes.com" {
		t.Fatalf("ui host = %q", plan.UIHost)
	}
	if plan.Port != onboard.DaemonPort {
		t.Fatalf("daemon port = %d", plan.Port)
	}
	if plan.UIPort != onboard.OpenCodePort {
		t.Fatalf("editor port = %d", plan.UIPort)
	}
}
