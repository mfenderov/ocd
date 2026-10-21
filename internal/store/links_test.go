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

// The sweep pushes the audit rows the brain has not seen yet. It reads
// them by rowid: the watermark is the rowid of the last row reported, so
// a restart does not re-send the whole history.
func TestRecentAuditSince(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	first := st.AuditUA("web:1.2.3.4", "tapped", "mac", "1.2.3.4", "ok", "curl/8")
	second := st.AuditUA("web:1.2.3.4", "tap_denied", "", "1.2.3.4", "used-or-expired", "")
	third := st.AuditUA("tg:owner", "link_issued", "mac", "", "ok", "")

	rows, err := st.RecentAuditSince(0)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 {
		t.Fatalf("want all three rows, got %d: %+v", len(rows), rows)
	}
	wantActions := []string{"tapped", "tap_denied", "link_issued"}
	for i, want := range wantActions {
		if rows[i].Action != want {
			t.Fatalf("want %q in row %d, got %q", want, i, rows[i].Action)
		}
	}
	if rows[0].RowID != first || rows[1].RowID != second || rows[2].RowID != third {
		t.Fatalf("want the rowids %d, %d, %d, got %d, %d, %d", first, second, third, rows[0].RowID, rows[1].RowID, rows[2].RowID)
	}
	if rows[0].UA != "curl/8" {
		t.Fatalf("want the user agent kept, got %q", rows[0].UA)
	}

	rows, err = st.RecentAuditSince(second)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("want only the row after the second one, got %d: %+v", len(rows), rows)
	}
	if rows[0].Action != "link_issued" {
		t.Fatalf("want the last row, got %q", rows[0].Action)
	}
}

// The watermark is the rowid of the last audit row the box reported. It
// starts at 0: nothing reported yet.
func TestAuditWatermark(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if got := st.AuditWatermark(); got != 0 {
		t.Fatalf("want no watermark before the first push, got %d", got)
	}
	if err := st.SetAuditWatermark(42); err != nil {
		t.Fatal(err)
	}
	if got := st.AuditWatermark(); got != 42 {
		t.Fatalf("want the watermark 42, got %d", got)
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
