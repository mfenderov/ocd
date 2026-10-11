package store

import (
	"testing"
)

// White-box: backdating a token past the TTL must make its key miss,
// pinning the expired-but-unclaimed reuse path at the SQL predicate.
func TestLookupIdemRejectsExpiredToken(t *testing.T) {
	st, _ := Open(":memory:")
	defer st.Close()
	tok, _ := st.IssueLink("mac", "admin")
	if !st.ClaimIdem("key-1", tok) {
		t.Fatal("setup: fresh key must claim")
	}
	_, _ = st.db.Exec(`UPDATE link_tokens SET created_at=strftime('%s','now')-? WHERE token=?`, int64(linkTTL.Seconds())+60, tok)
	if _, ok := st.LookupIdem("key-1"); ok {
		t.Fatal("expired-but-unclaimed token must miss")
	}
}

// The idem row's own age is not authoritative: a live token stays
// reusable even if its mapping row is old.
func TestLookupIdemIgnoresIdemRowAge(t *testing.T) {
	st, _ := Open(":memory:")
	defer st.Close()
	tok, _ := st.IssueLink("mac", "admin")
	if !st.ClaimIdem("key-1", tok) {
		t.Fatal("setup: fresh key must claim")
	}
	_, _ = st.db.Exec(`UPDATE idem SET created_at=strftime('%s','now')-? WHERE key=?`, int64(linkTTL.Seconds())+60, "key-1")
	got, ok := st.LookupIdem("key-1")
	if !ok || got != tok {
		t.Fatalf("want live %q, got %q %v", tok, got, ok)
	}
}
