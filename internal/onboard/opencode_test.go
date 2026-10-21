package onboard_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/mfenderov/ocd/internal/onboard"
)

// The OpenCode service port is not fixed: a fresh install picks a free
// one. The tunnel must follow the running service, not a constant.
func TestDiscoverOpenCodePort(t *testing.T) {
	dir := t.TempDir()
	script := "#!/bin/sh\necho 'http://127.0.0.1:31047'\n"
	//nolint:gosec // the stub binary must be executable: it stands in for a real one.
	if err := os.WriteFile(filepath.Join(dir, "opencode"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	port, err := onboard.DiscoverOpenCodePort(context.Background())
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if port != 31047 {
		t.Fatalf("want 31047, got %d", port)
	}
}

func TestDiscoverOpenCodePortFallsBackWhenMissing(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	port, note := onboard.OpenCodePortOrDefault(context.Background())
	if port != onboard.OpenCodePort {
		t.Fatalf("want the default port, got %d", port)
	}
	if note == "" {
		t.Fatal("fallback must explain why")
	}
}

// The service status output without a port is no port: the onboarding
// must not guess one, or the editor's hostname points at nothing.
func TestDiscoverOpenCodePortRefusesOutputWithoutAPort(t *testing.T) {
	dir := t.TempDir()
	script := "#!/bin/sh\necho 'http://127.0.0.1'\n"
	//nolint:gosec // the stub binary must be executable: it stands in for a real one.
	if err := os.WriteFile(filepath.Join(dir, "opencode"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	if _, err := onboard.DiscoverOpenCodePort(context.Background()); err == nil {
		t.Fatal("want an error when the service reports no port")
	}
}
