package cli

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestShouldManageTunnel(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("OCD_MANAGE_TUNNEL", "1")
	if shouldManageTunnel() {
		t.Fatal("no config means no supervision")
	}
	if err := os.MkdirAll(filepath.Join(dir, ".cloudflared"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".cloudflared", "config.yml"), []byte("tunnel: x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !shouldManageTunnel() {
		t.Fatal("opt-in flag plus config must supervise")
	}
	t.Setenv("OCD_MANAGE_TUNNEL", "0")
	if shouldManageTunnel() {
		t.Fatal("opt-out must win over config")
	}
}

func TestOnboardTunnelDefaultsAndSkip(t *testing.T) {
	tp, err := onboardTunnel(context.Background(), "", "", "", "mac", "oc-tap-mac.buyallmemes.com", false, io.Discard)
	if err != nil {
		t.Fatalf("defaults: %v", err)
	}
	if tp == nil || tp.Name != "oc-mac" || tp.UIHost != "oc-mac.buyallmemes.com" || tp.TapHost != "oc-tap-mac.buyallmemes.com" || tp.Port != 49400 {
		t.Fatalf("bad defaults: %+v", tp)
	}
	tp, err = onboardTunnel(context.Background(), "custom", "ui.example.com", "tok", "mac", "tap.example.com", false, io.Discard)
	if err != nil || tp.Name != "custom" || tp.UIHost != "ui.example.com" || tp.APIToken != "tok" {
		t.Fatalf("explicit values must win: %+v %v", tp, err)
	}
	tp, err = onboardTunnel(context.Background(), "", "", "", "mac", "tap.example.com", true, io.Discard)
	if err != nil || tp != nil {
		t.Fatalf("skip must yield nil plan: %+v %v", tp, err)
	}
}
