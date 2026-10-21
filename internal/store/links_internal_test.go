package store

import (
	"testing"
)

// openStore opens a store for the test and closes it when the test ends.
func openStore(t *testing.T) *Store {
	t.Helper()
	st, err := Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// White-box: the brain has to learn that a link died, so the box reports
// the tokens that were never used and are past their TTL. A token that
// was used is spent, not dead, and a fresh token is not dead yet.
func TestExpiredLinkTokens(t *testing.T) {
	st := openStore(t)

	dead := issueLink(t, st, "admin", brainLinkVia)
	spent := issueLink(t, st, "admin", brainLinkVia)
	fresh := issueLink(t, st, "admin", brainLinkVia)
	// The dead token was never used and is past the TTL.
	ageToken(t, st, dead)
	// The spent token was used, so it died of old age, not of neglect.
	if _, ok := st.ConsumeLink(t.Context(), spent); !ok {
		t.Fatal("setup: the fresh token must be consumable")
	}

	got, err := st.ExpiredLinkTokens(t.Context(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != dead {
		t.Fatalf("want only the dead token %q, got %v", dead, got)
	}
	for _, tok := range got {
		if tok == spent {
			t.Fatalf("a used token is not dead, got %v", got)
		}
		if tok == fresh {
			t.Fatalf("a fresh token is not dead, got %v", got)
		}
	}
}

// issueLink issues a link for the test and returns its token.
func issueLink(t *testing.T, st *Store, device, via string) string {
	t.Helper()
	tok, err := st.IssueLink(t.Context(), device, via)
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

// ageToken backdates a token past its TTL: it was never used, and it is
// dead.
func ageToken(t *testing.T, st *Store, tok string) {
	t.Helper()
	_, _ = st.db.ExecContext(t.Context(),
		`UPDATE link_tokens SET created_at=strftime('%s','now')-? WHERE token=?`,
		int64(linkTTL.Seconds())+60, tok)
}

// The Go bot mints its own links and edits their Telegram messages
// itself. Only the brain's own links are the brain's business.
func TestExpiredLinkTokensOnlyTheBrains(t *testing.T) {
	st, err := Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	brain, err := st.IssueLink(t.Context(), "admin", brainLinkVia)
	if err != nil {
		t.Fatal(err)
	}
	bot, err := st.IssueLink(t.Context(), "mac", "telegram")
	if err != nil {
		t.Fatal(err)
	}
	// Both are dead: never used, past the TTL.
	for _, tok := range []string{brain, bot} {
		_, _ = st.db.ExecContext(t.Context(), `UPDATE link_tokens SET created_at=strftime('%s','now')-? WHERE `+
			`token=?`, int64(linkTTL.Seconds())+60, tok)
	}

	got, err := st.ExpiredLinkTokens(t.Context(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != brain {
		t.Fatalf("want only the brain's dead token %q, got %v", brain, got)
	}
}

// The sweep reports the oldest dead links first and never more than the
// limit it was given.
func TestExpiredLinkTokensOldestFirstAndLimited(t *testing.T) {
	st, err := Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	tokens := make([]string, 3)
	for i := range tokens {
		tokens[i], err = st.IssueLink(t.Context(), "admin", brainLinkVia)
		if err != nil {
			t.Fatal(err)
		}
		// The older the token, the bigger the age: tokens[2] is the oldest.
		_, _ = st.db.ExecContext(t.Context(), `UPDATE link_tokens SET created_at=strftime('%s','now')-? WHERE `+
			`token=?`, int64(linkTTL.Seconds())+int64(60+i*60), tokens[i])
	}

	got, err := st.ExpiredLinkTokens(t.Context(), 2)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{tokens[2], tokens[1]}
	if len(got) != len(want) {
		t.Fatalf("want %v (the limit), got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("want %v oldest first, got %v", want, got)
		}
	}
}

// A dead token is worth nothing: once the brain has been told the link
// died, the row goes, so no sweep reports it again.
func TestDeleteLinkTokensRemovesTheRows(t *testing.T) {
	st, err := Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	dead, err := st.IssueLink(t.Context(), "admin", brainLinkVia)
	if err != nil {
		t.Fatal(err)
	}
	alive, err := st.IssueLink(t.Context(), "admin", brainLinkVia)
	if err != nil {
		t.Fatal(err)
	}

	if err := st.DeleteLinkTokens(t.Context(), []string{dead}); err != nil {
		t.Fatal(err)
	}

	if n := countLinkTokens(t, st, dead); n != 0 {
		t.Fatalf("want the deleted token gone, got %d rows", n)
	}
	if n := countLinkTokens(t, st, alive); n != 1 {
		t.Fatalf("want the other token untouched, got %d rows", n)
	}
	// Deleting a token that is not there is not an error: the sweep may
	// run twice over the same dead link.
	if err := st.DeleteLinkTokens(t.Context(), []string{"gone-already"}); err != nil {
		t.Fatalf("want deleting an unknown token to be harmless, got %v", err)
	}
}

// The Go bot's own links are the Go bot's business: deleting one would
// take away the expired-link edit its own sweeper still has to make.
func TestDeleteLinkTokensOnlyTheBrains(t *testing.T) {
	st, err := Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	bot, err := st.IssueLink(t.Context(), "mac", "telegram")
	if err != nil {
		t.Fatal(err)
	}

	if err := st.DeleteLinkTokens(t.Context(), []string{bot}); err != nil {
		t.Fatal(err)
	}

	if n := countLinkTokens(t, st, bot); n != 1 {
		t.Fatalf("want the Go bot's link left alone, got %d rows", n)
	}
}

// The prune keeps the newest row — it was written a moment ago — so the
// trail does not normally empty and its rowids do not repeat. The
// watermark is a rowid of the trail, so it keeps pointing at a rowid the
// trail knows.
//
// The trail can be emptied one day (a prune that runs before any write, a
// command that clears the audit, a VACUUM): its rowids start over, and
// the watermark then points past every row that follows. The sweep
// repairs it then (RepairAuditWatermark) instead of obeying it, so the
// push continues.
func TestPruneKeepsTheNewestRow(t *testing.T) {
	st, err := Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	// An old trail: rows written 100 days ago.
	for range 3 {
		if _, err := st.db.ExecContext(t.Context(), `INSERT INTO audit(at, actor, action, device, ip, result, ua) `+
			`VALUES(strftime('%s','now')-100*86400,'web:1.2.3.4','tapped','mac','1.2.3.4','ok','')`); err != nil {
			t.Fatal(err)
		}
	}
	// A fresh write, then the prune that write triggers.
	fresh := st.AuditUA(t.Context(), "web:1.2.3.4", "tapped", "mac", "1.2.3.4", "ok", "curl/8")
	st.prune(t.Context())

	rows, err := st.RecentAuditSince(t.Context(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("want the newest row kept by the prune, got %d rows", len(rows))
	}
	if rows[0].RowID != fresh {
		t.Fatalf("want the newest row %d kept, got %d", fresh, rows[0].RowID)
	}
	if rows[0].RowID <= 3 {
		t.Fatalf("want the rowids to move on, got %d", rows[0].RowID)
	}
}

// A database written before the anchor existed has a watermark and no
// anchor. It must not repair itself: the check that was there before —
// a watermark past the trail's last rowid — is the only thing there is.
func TestAuditWatermarkWithoutAnAnchorFallsBackToTheNumericCheck(t *testing.T) {
	st, err := Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	st.AuditUA(t.Context(), "web:1.2.3.4", "tapped", "mac", "1.2.3.4", "ok", "curl/8")
	// An old database: the watermark is in the meta table, and nothing
	// else is.
	if _, err := st.db.ExecContext(t.Context(), `INSERT INTO meta(k,v) VALUES('audit_watermark',1)`); err != nil {
		t.Fatal(err)
	}
	stale, err := st.AuditWatermarkStale(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if stale {
		t.Fatal("want a watermark inside the trail to stay fresh without an anchor")
	}
	// Past the trail's last rowid: stale, as it was before the anchor.
	if _, err := st.db.ExecContext(t.Context(), `UPDATE meta SET v=5000 WHERE k='audit_watermark'`); err != nil {
		t.Fatal(err)
	}
	stale, err = st.AuditWatermarkStale(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !stale {
		t.Fatal("want a watermark past the trail to be stale")
	}
}

// The trail was reset and refilled: the row at the watermark's rowid is
// another row. The rowid is a position, not an identity — the content
// is what tells them apart.
func TestAuditWatermarkIsStaleWhenItsRowWasReplaced(t *testing.T) {
	st, err := Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	rowid := st.AuditUA(t.Context(), "web:1.2.3.4", "tapped", "mac", "1.2.3.4", "ok", "curl/8")
	if err := st.SetAuditWatermark(t.Context(), rowid); err != nil {
		t.Fatal(err)
	}
	// The trail is emptied and refilled: the rowids start over, and the
	// row at the watermark's rowid is another row — the same second,
	// another action.
	if _, err := st.db.ExecContext(t.Context(), `DELETE FROM audit`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.db.ExecContext(t.Context(), `INSERT INTO audit(at, actor, action, device, ip, result, ua) `+
		`VALUES(strftime('%s','now'),'web:1.2.3.4','tap_denied','','1.2.3.4','used-or-expired','')`); err != nil {
		t.Fatal(err)
	}
	stale, err := st.AuditWatermarkStale(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !stale {
		t.Fatal("want the watermark stale: the row it named is another row")
	}
}

func countLinkTokens(t *testing.T, st *Store, tok string) int {
	t.Helper()
	var n int
	if err := st.db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM link_tokens WHERE `+
		`token=?`, tok).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
