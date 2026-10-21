package onboard

import (
	"context"
	"strings"
	"testing"
)

// The unit must be restarted as a user unit: the box runs inside the
// operator's login session.
func TestRestartSystemdUnitRestartsTheUserUnit(t *testing.T) {
	calls := fakeBinary(t, "systemctl", "exit 0\n")
	restart := restartSystemdUnit

	if err := restart(context.Background(), ServeUnit); err != nil {
		t.Fatalf("restart: %v", err)
	}
	got := recordedCalls(t, calls)
	if !strings.Contains(got, "--user restart "+ServeUnit) {
		t.Fatalf("want the user unit restarted, got %q", got)
	}
}

// A systemctl that fails must say so: the caller needs to know the unit
// still runs what it loaded at boot.
func TestRestartSystemdUnitReportsAFailedRestart(t *testing.T) {
	calls := fakeBinary(t, "systemctl", "echo 'Unit ocd-serve.service not loaded.'\nexit 1\n")
	restart := restartSystemdUnit

	err := restart(context.Background(), ServeUnit)
	if err == nil {
		t.Fatal("a failed restart must be reported")
	}
	for _, want := range []string{"systemctl --user restart " + ServeUnit, "Unit ocd-serve.service not loaded."} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("the error must name %q, got %v", want, err)
		}
	}
	if got := recordedCalls(t, calls); !strings.Contains(got, "--user restart "+ServeUnit) {
		t.Fatalf("want the user unit restarted, got %q", got)
	}
}

// A box without systemd cannot restart a unit: the error says so.
func TestRestartSystemdUnitReportsAMissingSystemctl(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	restart := restartSystemdUnit

	err := restart(context.Background(), ServeUnit)
	if err == nil {
		t.Fatal("a box without systemctl must be reported")
	}
	if !strings.Contains(err.Error(), "systemctl is not on this box") {
		t.Fatalf("the error must name the missing systemctl, got %v", err)
	}
}
