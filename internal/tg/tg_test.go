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
