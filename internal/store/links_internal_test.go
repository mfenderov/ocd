package store

import (
	"testing"
)

// White-box: the brain has to learn that a link died, so the box reports
// the tokens that were never used and are past their TTL. A token that
// was used is spent, not dead, and a fresh token is not dead yet.
func TestExpiredLinkTokens(t *testing.T) {
	st, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	dead, err := st.IssueLink("mac", "telegram")
	if err != nil {
		t.Fatal(err)
	}
	spent, err := st.IssueLink("mac", "telegram")
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := st.IssueLink("mac", "telegram")
	if err != nil {
		t.Fatal(err)
	}
	// The dead token was never used and is past the TTL.
	_, _ = st.db.Exec(`UPDATE link_tokens SET created_at=strftime('%s','now')-? WHERE token=?`, int64(linkTTL.Seconds())+60, dead)
	// The spent token was used, so it died of old age, not of neglect.
	if _, ok := st.ConsumeLink(spent); !ok {
		t.Fatal("setup: the fresh token must be consumable")
	}

	got, err := st.ExpiredLinkTokens(10)
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

// The sweep reports the oldest dead links first and never more than the
// limit it was given.
func TestExpiredLinkTokensOldestFirstAndLimited(t *testing.T) {
	st, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	tokens := make([]string, 3)
	for i := range tokens {
		tokens[i], err = st.IssueLink("mac", "telegram")
		if err != nil {
			t.Fatal(err)
		}
		// The older the token, the bigger the age: tokens[2] is the oldest.
		_, _ = st.db.Exec(`UPDATE link_tokens SET created_at=strftime('%s','now')-? WHERE token=?`, int64(linkTTL.Seconds())+int64(60+i*60), tokens[i])
	}

	got, err := st.ExpiredLinkTokens(2)
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
	st, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	dead, err := st.IssueLink("mac", "telegram")
	if err != nil {
		t.Fatal(err)
	}
	alive, err := st.IssueLink("mac", "telegram")
	if err != nil {
		t.Fatal(err)
	}

	if err := st.DeleteLinkTokens([]string{dead}); err != nil {
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
	if err := st.DeleteLinkTokens([]string{"gone-already"}); err != nil {
		t.Fatalf("want deleting an unknown token to be harmless, got %v", err)
	}
}

func countLinkTokens(t *testing.T, st *Store, tok string) int {
	t.Helper()
	var n int
	if err := st.db.QueryRow(`SELECT COUNT(*) FROM link_tokens WHERE token=?`, tok).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
