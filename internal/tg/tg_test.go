package tg_test

import (
	"testing"

	"github.com/mfenderov/ocd/internal/tg"
)

func TestStrangerGetsNothing(t *testing.T) {
	if got := tg.HandleLogin(999, "/login", 1); got != "" {
		t.Fatalf("stranger must get silent drop, got %q", got)
	}
}

func TestOwnerDeniedWithoutDevice(t *testing.T) {
	got := tg.HandleLogin(1, "/login", 1)
	if got == "" {
		t.Fatal("owner must get a reply (link or wait message)")
	}
}

func TestGroupGateAllowsOnlyConfiguredGroup(t *testing.T) {
	if !tg.AllowedChat("supergroup", -100123, -100123) {
		t.Fatal("configured group must be allowed")
	}
	if tg.AllowedChat("supergroup", -100999, -100123) {
		t.Fatal("other group must be denied")
	}
	if tg.AllowedChat("group", 5, 0) {
		t.Fatal("group with no configured id must be denied")
	}
	if !tg.AllowedChat("private", 777, -100123) {
		t.Fatal("DM must always be allowed")
	}
}

func TestAddressedCommandsRouteToOwnBot(t *testing.T) {
	cmd, ok := tg.NormalizeCommand("/login@ocd_bambot", "ocd_bambot", true)
	if !ok || cmd != "/login" {
		t.Fatalf("own suffix must route stripped, got %q %v", cmd, ok)
	}
	if _, ok := tg.NormalizeCommand("/login@ocd_work", "ocd_bambot", true); ok {
		t.Fatal("other bot suffix must be ignored")
	}
	if _, ok := tg.NormalizeCommand("/login", "ocd_bambot", true); ok {
		t.Fatal("bare command in group must be ignored (avoids double fire)")
	}
	cmd, ok = tg.NormalizeCommand("/login", "ocd_bambot", false)
	if !ok || cmd != "/login" {
		t.Fatalf("bare command in DM must pass, got %q %v", cmd, ok)
	}
	cmd, ok = tg.NormalizeCommand("/revoke YES", "ocd_bambot", false)
	if !ok || cmd != "/revoke YES" {
		t.Fatalf("args must survive normalize, got %q %v", cmd, ok)
	}
}
