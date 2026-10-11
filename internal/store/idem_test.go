package store_test

import (
	"testing"

	"github.com/mfenderov/ocd/internal/store"
)

func TestIdemLookupUnknownKey(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	if _, ok := st.LookupIdem("nope"); ok {
		t.Fatal("unknown key must miss")
	}
}

func TestIdemRoundTrip(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	tok, _ := st.IssueLink("mac", "admin")
	if err := st.RecordIdem("key-1", tok); err != nil {
		t.Fatalf("record: %v", err)
	}
	got, ok := st.LookupIdem("key-1")
	if !ok || got != tok {
		t.Fatalf("want %q live, got %q %v", tok, got, ok)
	}
}

func TestIdemRejectsClaimedToken(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	tok, _ := st.IssueLink("mac", "admin")
	_ = st.RecordIdem("key-1", tok)
	if _, ok := st.ConsumeLink(tok); !ok {
		t.Fatal("setup: token must consume")
	}
	if _, ok := st.LookupIdem("key-1"); ok {
		t.Fatal("claimed token must miss")
	}
}

func TestIdemPersistsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	st, _ := store.Open(dir + "/i.db")
	tok, _ := st.IssueLink("mac", "admin")
	_ = st.RecordIdem("key-1", tok)
	st.Close()
	st2, _ := store.Open(dir + "/i.db")
	defer st2.Close()
	got, ok := st2.LookupIdem("key-1")
	if !ok || got != tok {
		t.Fatalf("want persisted %q, got %q %v", tok, got, ok)
	}
}
