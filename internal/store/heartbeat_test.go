package store_test

import (
	"testing"

	"github.com/mfenderov/ocd/internal/store"
)

func TestHeartbeatSeqIncrements(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	if got := st.NextHeartbeatSeq(); got != 1 {
		t.Fatalf("want 1, got %d", got)
	}
	if got := st.NextHeartbeatSeq(); got != 2 {
		t.Fatalf("want 2, got %d", got)
	}
}
