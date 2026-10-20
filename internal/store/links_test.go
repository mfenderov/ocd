package store_test

import (
	"encoding/json"
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

// A background writer can outlive the store's shutdown. Auditing into a
// closed store must not panic: a panic in a goroutine kills the whole
// process, and the box has to survive its own shutdown.
func TestAuditOnAClosedStoreDoesNotPanic(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	if id := st.AuditUA("box:mac", "push_failed", "mac", "1.2.3.4", "boom", "curl/8"); id != 0 {
		t.Fatalf("want no row id from a closed store, got %d", id)
	}
}

func TestAuditRowMarshalSnakeCaseKeys(t *testing.T) {
	row := store.AuditRow{At: 1, Actor: "a", Action: "b", Device: "c", IP: "d", Result: "e", UA: "f"}
	raw, err := json.Marshal(row)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	wantKeys := map[string]bool{"at": true, "actor": true, "action": true, "device": true, "ip": true, "result": true, "ua": true}
	if len(body) != len(wantKeys) {
		t.Fatalf("want exact keys %v, got %v", wantKeys, body)
	}
	for key := range body {
		if !wantKeys[key] {
			t.Fatalf("want exact keys %v, got %v", wantKeys, body)
		}
	}
}
