package store_test

import (
	"testing"

	"github.com/mfenderov/ocd/internal/store"
)

// openStore opens a store for the test and closes it when the test ends.
func openStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func TestAddAndGetDevice(t *testing.T) {
	st, err := store.Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.AddDevice(t.Context(), "mac", "darwin"); err != nil {
		t.Fatal(err)
	}
	d, ok := st.GetDevice(t.Context(), "mac")
	if !ok || d.Name != "mac" {
		t.Fatalf("want mac, got %+v ok=%v", d, ok)
	}
}

// The devices are listed by name: the console shows them in one stable
// order.
func TestListDevices(t *testing.T) {
	st, err := store.Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	for _, name := range []string{"mac", "box", "wsl"} {
		if err := st.AddDevice(t.Context(), name, "linux"); err != nil {
			t.Fatal(err)
		}
	}

	got := st.ListDevices(t.Context())

	want := []string{"box", "mac", "wsl"}
	if len(got) != len(want) {
		t.Fatalf("want %v, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("want %v, got %v", want, got)
		}
	}
}
