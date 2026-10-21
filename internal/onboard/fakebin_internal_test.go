package onboard

import (
	"os"
	"path/filepath"
	"testing"
)

// fakeBinary installs a stub binary on PATH that records the arguments
// it was asked with, and runs the given body. No test runs a real
// system binary.
func fakeBinary(t *testing.T, name, body string) string {
	t.Helper()
	dir := t.TempDir()
	calls := filepath.Join(dir, "calls")
	script := "#!/bin/sh\necho \"$@\" >> " + calls + "\n" + body
	//nolint:gosec // the stub binary must be executable: it stands in for a real one.
	if err := os.WriteFile(filepath.Join(dir, name), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	return calls
}

// recordedCalls is what the stub binary was asked to run.
func recordedCalls(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the stub recorded nothing: %v", err)
	}
	return string(raw)
}
