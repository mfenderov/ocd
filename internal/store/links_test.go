package store_test

import (
	"encoding/json"
	"testing"

	"github.com/mfenderov/ocd/internal/store"
)

func TestIssueConsumeLinkOnce(t *testing.T) {
	st, err := store.Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	tok, err := st.IssueLink(t.Context(), "mac", "telegram")
	if err != nil || tok == "" {
		t.Fatalf("issue: %v %q", err, tok)
	}
	dev, ok := st.ConsumeLink(t.Context(), tok)
	if !ok || dev != "mac" {
		t.Fatalf("first tap must consume: %q %v", dev, ok)
	}
	if _, ok := st.ConsumeLink(t.Context(), tok); ok {
		t.Fatal("second tap must be denied")
	}
}

func TestAuditRoundTrip(t *testing.T) {
	st, _ := store.Open(t.Context(), ":memory:")
	defer st.Close()
	st.Audit(t.Context(), "tg:1", "link_issued", "mac", "", "ok")
	rows := st.RecentAudit(t.Context(), 5)
	if len(rows) != 1 || rows[0].Action != "link_issued" {
		t.Fatalf("want 1 link_issued row, got %+v", rows)
	}
}

// A background writer can outlive the store's shutdown. Auditing into a
// closed store must not panic: a panic in a goroutine kills the whole
// process, and the box has to survive its own shutdown.
func TestAuditOnAClosedStoreDoesNotPanic(t *testing.T) {
	st, err := store.Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	if id := st.AuditUA(t.Context(), "box:mac", "push_failed", "mac", "1.2.3.4", "boom", "curl/8"); id != 0 {
		t.Fatalf("want no row id from a closed store, got %d", id)
	}
}

// The sweep pushes the audit rows the brain has not seen yet. It reads
// them by rowid: the watermark is the rowid of the last row reported, so
// a restart does not re-send the whole history.
func TestRecentAuditSinceReturnsTheWholeTrail(t *testing.T) {
	st := openStore(t)
	first := st.AuditUA(t.Context(), "web:1.2.3.4", "tapped", "mac", "1.2.3.4", "ok", "curl/8")
	second := st.AuditUA(t.Context(), "web:1.2.3.4", "tap_denied", "", "1.2.3.4", "used-or-expired", "")
	third := st.AuditUA(t.Context(), "tg:owner", "link_issued", "mac", "", "ok", "")

	rows, err := st.RecentAuditSince(t.Context(), 0)
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
		t.Fatalf("want the rowids %d, %d, %d, got %d, %d, %d",
			first, second, third, rows[0].RowID, rows[1].RowID, rows[2].RowID)
	}
	if rows[0].UA != "curl/8" {
		t.Fatalf("want the user agent kept, got %q", rows[0].UA)
	}
}

// The watermark says how far the box got: the rows after it are the ones
// the brain has not seen yet.
func TestRecentAuditSinceReturnsOnlyWhatIsAfterTheWatermark(t *testing.T) {
	st := openStore(t)
	st.AuditUA(t.Context(), "web:1.2.3.4", "tapped", "mac", "1.2.3.4", "ok", "curl/8")
	second := st.AuditUA(t.Context(), "web:1.2.3.4", "tap_denied", "", "1.2.3.4", "used-or-expired", "")
	st.AuditUA(t.Context(), "tg:owner", "link_issued", "mac", "", "ok", "")

	rows, err := st.RecentAuditSince(t.Context(), second)
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
	st, err := store.Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	got, err := st.AuditWatermark(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if got != 0 {
		t.Fatalf("want no watermark before the first push, got %d", got)
	}
	if err := st.SetAuditWatermark(t.Context(), 42); err != nil {
		t.Fatal(err)
	}
	got, err = st.AuditWatermark(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if got != 42 {
		t.Fatalf("want the watermark 42, got %d", got)
	}
}

// The watermark only moves forward. A rowid below the stored one is
// ignored: a lower watermark would re-offer rows the brain already has
// and send the box's history backwards.
func TestAuditWatermarkNeverMovesBackwards(t *testing.T) {
	st, err := store.Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	rowid := st.AuditUA(t.Context(), "web:1.2.3.4", "tapped", "mac", "1.2.3.4", "ok", "curl/8")
	if err := st.SetAuditWatermark(t.Context(), rowid); err != nil {
		t.Fatal(err)
	}
	if err := st.SetAuditWatermark(t.Context(), rowid-1); err != nil {
		t.Fatal(err)
	}
	got, err := st.AuditWatermark(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if got != rowid {
		t.Fatalf("want the watermark to stay at %d, got %d", rowid, got)
	}
}

// The trail was reset and its rowids started over: the stored watermark
// points past every row. The repair puts the watermark back at the
// start of the trail, so the push continues instead of going silent.
func TestRepairAuditWatermark(t *testing.T) {
	st, err := store.Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.SetAuditWatermark(t.Context(), 5000); err != nil {
		t.Fatal(err)
	}
	if err := st.RepairAuditWatermark(t.Context()); err != nil {
		t.Fatal(err)
	}
	got, err := st.AuditWatermark(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if got != 0 {
		t.Fatalf("want the watermark repaired to the start of the trail, got %d", got)
	}
}

// The watermark is anchored to the row it names: the row's own content
// is stored next to it, so the box can tell "the same row" from "the
// same number". A rowid is a position, not an identity.
func TestAuditWatermarkAnchorsItsRow(t *testing.T) {
	st := openStore(t)

	rowid := st.AuditUA(t.Context(), "web:1.2.3.4", "tapped", "mac", "1.2.3.4", "ok", "curl/8")
	if err := st.SetAuditWatermark(t.Context(), rowid); err != nil {
		t.Fatal(err)
	}
	anchor := watermarkAnchor(t, st)
	rows, err := st.RecentAuditSince(t.Context(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("want one row, got %d", len(rows))
	}
	if anchor.At != rows[0].At || anchor.Action != rows[0].Action {
		t.Fatalf("want the anchor to name the row (%d, %q), got (%d, %q)",
			rows[0].At, rows[0].Action, anchor.At, anchor.Action)
	}
	// The row is still the row: the watermark is not stale.
	stale, err := st.AuditWatermarkStale(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if stale {
		t.Fatal("want a live watermark to be fresh")
	}
}

// The anchor stays with the row the watermark names: a watermark that
// does not move does not take the anchor with it.
func TestAuditAnchorDoesNotMoveBackwards(t *testing.T) {
	st := openStore(t)

	first := st.AuditUA(t.Context(), "web:1.2.3.4", "tapped", "mac", "1.2.3.4", "ok", "curl/8")
	second := st.AuditUA(t.Context(), "web:1.2.3.4", "tap_denied", "", "1.2.3.4", "used-or-expired", "")
	if err := st.SetAuditWatermark(t.Context(), second); err != nil {
		t.Fatal(err)
	}
	anchor := watermarkAnchor(t, st)
	// A lower watermark is ignored: the anchor must keep naming the row
	// the watermark names.
	if err := st.SetAuditWatermark(t.Context(), first); err != nil {
		t.Fatal(err)
	}
	after := watermarkAnchor(t, st)
	if after != anchor {
		t.Fatalf("want the anchor left on %+v, got %+v", anchor, after)
	}
	watermark, err := st.AuditWatermark(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if watermark != second {
		t.Fatalf("want the watermark left at %d, got %d", second, watermark)
	}
}

// The repair puts the watermark back to the start of the trail, and the
// anchor goes with it: the watermark names no row any more.
func TestRepairAuditWatermarkDropsTheAnchor(t *testing.T) {
	st, err := store.Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	rowid := st.AuditUA(t.Context(), "web:1.2.3.4", "tapped", "mac", "1.2.3.4", "ok", "curl/8")
	if err := st.SetAuditWatermark(t.Context(), rowid); err != nil {
		t.Fatal(err)
	}
	if err := st.RepairAuditWatermark(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := st.WatermarkAnchor(t.Context()); err != nil || ok {
		t.Fatalf("want the anchor dropped, ok=%v err=%v", ok, err)
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
	wantKeys := map[string]bool{
		"at": true, "actor": true, "action": true, "device": true,
		"ip": true, "result": true, "ua": true,
	}
	if len(body) != len(wantKeys) {
		t.Fatalf("want exact keys %v, got %v", wantKeys, body)
	}
	for key := range body {
		if !wantKeys[key] {
			t.Fatalf("want exact keys %v, got %v", wantKeys, body)
		}
	}
}

// watermarkAnchor reads the anchor stored next to the watermark. The
// anchor must be there: the tests that read it check what it names.
func watermarkAnchor(t *testing.T, st *store.Store) store.AuditAnchor {
	t.Helper()
	anchor, ok, err := st.WatermarkAnchor(t.Context())
	if err != nil || !ok {
		t.Fatalf("want the anchor stored, ok=%v err=%v", ok, err)
	}
	return anchor
}
