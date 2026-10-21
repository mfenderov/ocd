package onboard

import (
	"errors"
	"testing"
)

// The uid of the login session, with `id -u` standing in for the
// machine.
func TestLoginUIDFromTheEnvironment(t *testing.T) {
	t.Setenv("UID", "501")
	uid, err := loginUID()
	if err != nil {
		t.Fatalf("loginUID: %v", err)
	}
	if uid != "501" {
		t.Fatalf("want the uid from the environment, got %q", uid)
	}
}

func TestLoginUIDFromID(t *testing.T) {
	t.Setenv("UID", "")
	restore := idCommand
	idCommand = func() ([]byte, error) { return []byte("501\n"), nil }
	t.Cleanup(func() { idCommand = restore })

	uid, err := loginUID()
	if err != nil {
		t.Fatalf("loginUID: %v", err)
	}
	if uid != "501" {
		t.Fatalf("want the trimmed uid, got %q", uid)
	}
}

// `id -u` that printed nothing must not take the process down.
func TestLoginUIDSurvivesAnEmptyID(t *testing.T) {
	t.Setenv("UID", "")
	restore := idCommand
	idCommand = func() ([]byte, error) { return []byte{}, nil }
	t.Cleanup(func() { idCommand = restore })

	uid, err := loginUID()
	if err != nil {
		t.Fatalf("loginUID: %v", err)
	}
	if uid != "" {
		t.Fatalf("want an empty uid, got %q", uid)
	}
}

func TestLoginUIDReportsTheFailure(t *testing.T) {
	t.Setenv("UID", "")
	restore := idCommand
	idCommand = func() ([]byte, error) { return nil, errors.New("no id here") }
	t.Cleanup(func() { idCommand = restore })

	if _, err := loginUID(); err == nil {
		t.Fatal("want the failure to be reported")
	}
}

// `id -u` that printed nothing must not take the process down. The uid
// of the service is read the same way as the uid of the login session,
// and an unreadable one leaves the service unknown, not the process
// dead.
func TestServiceUIDSurvivesAnEmptyID(t *testing.T) {
	t.Setenv("UID", "")
	fakeBinary(t, "id", "exit 0\n")

	uid, ok := serviceUID()
	if ok {
		t.Fatalf("an empty uid is not readable, got %q", uid)
	}
}

// The uid of the service comes from the environment.
func TestServiceUIDFromTheEnvironment(t *testing.T) {
	t.Setenv("UID", "501")

	uid, ok := serviceUID()
	if !ok {
		t.Fatal("want the uid to be readable")
	}
	if uid != "501" {
		t.Fatalf("want the uid from the environment, got %q", uid)
	}
}
