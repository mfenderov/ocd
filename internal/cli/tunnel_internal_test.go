package cli

import (
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
