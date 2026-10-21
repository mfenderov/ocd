package admin_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/mfenderov/ocd/internal/admin"
	"github.com/mfenderov/ocd/internal/store"
)

func TestRevokeRotatesAndMarksExpired(t *testing.T) {
	st, _ := store.Open(t.Context(), ":memory:")
	defer st.Close()
	st.AddDevice(t.Context(), "mac", "darwin")
	var ran []string
	exec := func(_ context.Context, name string, args ...string) (string, error) {
		ran = append(ran, name+" "+strings.Join(args, " "))
		if args[0] == "status" {
			return "http://127.0.0.1:49374", nil
		}
		return "", nil
	}
	if err := admin.Revoke(t.Context(), st, exec); err != nil {
		t.Fatal(err)
	}
	if len(ran) != 3 {
		t.Fatalf("want set+start+status, got %v", ran)
	}
	d, _ := st.GetDevice(t.Context(), "mac")
	if d.ExpiresAt != 0 {
		t.Fatalf("device must show expired, got %d", d.ExpiresAt)
	}
}

func TestRevokeAbortsWhenStartFails(t *testing.T) {
	st, _ := store.Open(t.Context(), ":memory:")
	defer st.Close()
	st.AddDevice(t.Context(), "mac", "darwin")
	exec := func(_ context.Context, name string, args ...string) (string, error) {
		if len(args) > 1 && args[1] == "start" {
			return "", errors.New("boom")
		}
		return "", nil
	}
	if err := admin.Revoke(t.Context(), st, exec); err == nil {
		t.Fatal("want error when start fails")
	}
}

// The status names the service and the devices: the operator reads it
// to see what this box serves.
func TestStatusNamesTheServiceAndTheDevices(t *testing.T) {
	st, _ := store.Open(t.Context(), ":memory:")
	defer st.Close()
	st.AddDevice(t.Context(), "mac", "darwin")
	exec := func(_ context.Context, _ string, _ ...string) (string, error) {
		return "http://127.0.0.1:49374\n", nil
	}

	got := admin.Status(context.Background(), st, exec)

	for _, want := range []string{"service=http://127.0.0.1:49374", "devices=1"} {
		if !strings.Contains(got, want) {
			t.Fatalf("the status must hold %q, got %q", want, got)
		}
	}
}

// A service that does not answer leaves the status saying so: the
// operator must not read a stale line as a live one.
func TestStatusReportsAServiceThatIsDown(t *testing.T) {
	st, _ := store.Open(t.Context(), ":memory:")
	defer st.Close()
	exec := func(_ context.Context, _ string, _ ...string) (string, error) {
		return "", errors.New("connection refused")
	}

	got := admin.Status(context.Background(), st, exec)

	if !strings.Contains(got, "service=DOWN") {
		t.Fatalf("the status must say the service is down, got %q", got)
	}
}
