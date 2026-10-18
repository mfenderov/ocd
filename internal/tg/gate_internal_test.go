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

func TestFleetArgParsing(t *testing.T) {
	if got := firstFleetArg("/flink home", "/flink"); got != "home" {
		t.Fatalf("flink box = %q", got)
	}
	if got := firstFleetArg("/flink", "/flink"); got != "" {
		t.Fatalf("bare flink must yield no box, got %q", got)
	}
	if box, ok := fleetBoxConfirm("/frevoke home YES", "/frevoke"); !ok || box != "home" {
		t.Fatalf("frevoke confirm = %q %v", box, ok)
	}
	if box, ok := fleetBoxConfirm("/frevoke home", "/frevoke"); ok || box != "home" {
		t.Fatalf("unconfirmed frevoke = %q %v", box, ok)
	}
	if box, ok := fleetBoxConfirm("/frevoke YES", "/frevoke"); ok || box != "" {
		t.Fatalf("bare YES is not a box: %q %v", box, ok)
	}
	if !hasFleetYes("/fnuke YES", "/fnuke") || hasFleetYes("/fnuke", "/fnuke") {
		t.Fatal("fnuke YES gate broken")
	}
	if box, n := fleetAuditArgs("/faudit mac 5", "/faudit"); box != "mac" || n != 5 {
		t.Fatalf("faudit args = %q %d", box, n)
	}
	if box, n := fleetAuditArgs("/faudit", "/faudit"); box != "" || n != 0 {
		t.Fatalf("bare faudit = %q %d", box, n)
	}
}
