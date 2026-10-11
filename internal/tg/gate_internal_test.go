package tg

import (
	"context"
	"testing"
	"time"

	"github.com/mfenderov/ocd/internal/store"
)

func TestHandleTextRefusesStranger(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	// nil bot: must return before touching it.
	handleText(context.Background(), nil, st, 1, 99, 999, "/audit")
	if n := st.CountRecentMints("", 24*time.Hour); n != 0 {
		t.Fatalf("stranger must get nothing, got %d", n)
	}
	rows := st.RecentAudit(5)
	for _, r := range rows {
		if r.Action != "stranger_denied" {
			t.Fatalf("unexpected audit row for refused stranger: %+v", rows)
		}
	}
}
