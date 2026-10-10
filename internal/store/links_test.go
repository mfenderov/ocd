package store_test

import (
	"testing"

	"github.com/mfenderov/ocd/internal/store"
)

func TestIssueConsumeLinkOnce(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	tok, err := st.IssueLink("mac", "telegram")
	if err != nil || tok == "" {
		t.Fatalf("issue: %v %q", err, tok)
	}
	dev, ok := st.ConsumeLink(tok)
	if !ok || dev != "mac" {
		t.Fatalf("first tap must consume: %q %v", dev, ok)
	}
	if _, ok := st.ConsumeLink(tok); ok {
		t.Fatal("second tap must be denied")
	}
}

func TestAuditRoundTrip(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	st.Audit("tg:1", "link_issued", "mac", "", "ok")
	rows := st.RecentAudit(5)
	if len(rows) != 1 || rows[0].Action != "link_issued" {
		t.Fatalf("want 1 link_issued row, got %+v", rows)
	}
}
