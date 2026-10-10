package store_test

import (
	"testing"

	"github.com/mfenderov/ocd/internal/store"
)

func TestAddAndGetDevice(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.AddDevice("mac", "darwin"); err != nil {
		t.Fatal(err)
	}
	d, ok := st.GetDevice("mac")
	if !ok || d.Name != "mac" {
		t.Fatalf("want mac, got %+v ok=%v", d, ok)
	}
}
