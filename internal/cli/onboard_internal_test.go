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
