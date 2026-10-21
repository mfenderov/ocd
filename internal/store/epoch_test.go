package store

import "testing"

func TestEpochMonotonicAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	st, _ := Open(t.Context(), dir+"/e.db")
	if got := st.PasswordEpoch(t.Context()); got != 0 {
		t.Fatalf("want 0, got %d", got)
	}
	if got := st.BumpEpoch(t.Context()); got != 1 {
		t.Fatalf("want 1, got %d", got)
	}
	st.Close()
	st2, _ := Open(t.Context(), dir+"/e.db")
	defer st2.Close()
	if got := st2.PasswordEpoch(t.Context()); got != 1 {
		t.Fatalf("want persisted 1, got %d", got)
	}
}
