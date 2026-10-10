package admin_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/mfenderov/ocd/internal/admin"
	"github.com/mfenderov/ocd/internal/store"
)

func TestRevokeRotatesAndMarksExpired(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	st.AddDevice("mac", "darwin")
	var ran []string
	exec := func(name string, args ...string) (string, error) {
		ran = append(ran, name+" "+strings.Join(args, " "))
		if args[0] == "status" {
			return "http://127.0.0.1:49374", nil
		}
		return "", nil
	}
	if err := admin.Revoke(st, exec); err != nil {
		t.Fatal(err)
	}
	if len(ran) != 3 {
		t.Fatalf("want set+start+status, got %v", ran)
	}
	d, _ := st.GetDevice("mac")
	if d.ExpiresAt != 0 {
		t.Fatalf("device must show expired, got %d", d.ExpiresAt)
	}
}

func TestRevokeAbortsWhenStartFails(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	st.AddDevice("mac", "darwin")
	exec := func(name string, args ...string) (string, error) {
		if len(args) > 1 && args[1] == "start" {
			return "", errors.New("boom")
		}
		return "", nil
	}
	if err := admin.Revoke(st, exec); err == nil {
		t.Fatal("want error when start fails")
	}
}
