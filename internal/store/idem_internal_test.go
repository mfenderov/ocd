package store

import (
	"testing"
)

// White-box: backdating a token past the TTL must make its key miss,
// pinning the expired-but-unclaimed reuse path at the SQL predicate.
func TestLookupIdemRejectsExpiredToken(t *testing.T) {
	st, _ := Open(t.Context(), ":memory:")
	defer st.Close()
	tok, _ := st.IssueLink(t.Context(), "mac", "admin")
	if !st.ClaimIdem(t.Context(), "key-1", tok) {
		t.Fatal("setup: fresh key must claim")
	}
	_, _ = st.db.ExecContext(t.Context(), `UPDATE link_tokens SET created_at=strftime('%s','now')-? WHERE `+
		`token=?`, int64(linkTTL.Seconds())+60, tok)
	if _, ok := st.LookupIdem(t.Context(), "key-1"); ok {
		t.Fatal("expired-but-unclaimed token must miss")
	}
}

// The idem row's own age is not authoritative: a live token stays
// reusable even if its mapping row is old.
func TestLookupIdemIgnoresIdemRowAge(t *testing.T) {
	st, _ := Open(t.Context(), ":memory:")
	defer st.Close()
	tok, _ := st.IssueLink(t.Context(), "mac", "admin")
	if !st.ClaimIdem(t.Context(), "key-1", tok) {
		t.Fatal("setup: fresh key must claim")
	}
	_, _ = st.db.ExecContext(t.Context(), `UPDATE idem SET created_at=strftime('%s','now')-? WHERE `+
		`key=?`, int64(linkTTL.Seconds())+60, "key-1")
	got, ok := st.LookupIdem(t.Context(), "key-1")
	if !ok || got != tok {
		t.Fatalf("want live %q, got %q %v", tok, got, ok)
	}
}
