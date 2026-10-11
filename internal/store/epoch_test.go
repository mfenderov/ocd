package store

import "testing"

func TestEpochMonotonicAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	st, _ := Open(dir + "/e.db")
	if got := st.PasswordEpoch(); got != 0 {
		t.Fatalf("want 0, got %d", got)
	}
	if got := st.BumpEpoch(); got != 1 {
		t.Fatalf("want 1, got %d", got)
	}
	st.Close()
	st2, _ := Open(dir + "/e.db")
	defer st2.Close()
	if got := st2.PasswordEpoch(); got != 1 {
		t.Fatalf("want persisted 1, got %d", got)
	}
}
