package boxagent_test

import (
	"testing"

	"github.com/mfenderov/ocd/internal/boxagent"
)

// The box's brain configuration lives in three environment variables, and
// the push clients need all three: the origin, the box id and the bearer.
func TestBrainConfigFromEnv(t *testing.T) {
	t.Setenv("OCD_WORKER_URL", "https://brain.example.com/api/heartbeat")
	t.Setenv("OCD_BOX_ID", "mac")
	t.Setenv("OCD_HEARTBEAT_TOKEN", "hb-secret")

	cfg := boxagent.BrainConfigFromEnv()
	if cfg.BrainURL != "https://brain.example.com/api/heartbeat" {
		t.Fatalf("want the brain URL, got %q", cfg.BrainURL)
	}
	if cfg.BoxID != "mac" {
		t.Fatalf("want the box id mac, got %q", cfg.BoxID)
	}
	if cfg.Token != "hb-secret" {
		t.Fatalf("want the heartbeat token, got %q", cfg.Token)
	}
	if !cfg.Ready() {
		t.Fatal("a fully configured box must be ready to push")
	}
}

// A box without a brain must not push: half a configuration is no
// configuration.
func TestBrainConfigNotReadyWhenUnset(t *testing.T) {
	t.Setenv("OCD_WORKER_URL", "")
	t.Setenv("OCD_BOX_ID", "")
	t.Setenv("OCD_HEARTBEAT_TOKEN", "")

	if boxagent.BrainConfigFromEnv().Ready() {
		t.Fatal("a box with no brain configured must not be ready")
	}
}
