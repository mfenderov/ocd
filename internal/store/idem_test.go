package store_test

import (
	"testing"

	"github.com/mfenderov/ocd/internal/store"
)

func TestIdemLookupUnknownKey(t *testing.T) {
	st, _ := store.Open(t.Context(), ":memory:")
	defer st.Close()
	if _, ok := st.LookupIdem(t.Context(), "nope"); ok {
		t.Fatal("unknown key must miss")
	}
}

func TestIdemClaimAndLookup(t *testing.T) {
	st, _ := store.Open(t.Context(), ":memory:")
	defer st.Close()
	tok, _ := st.IssueLink(t.Context(), "mac", "admin")
	if !st.ClaimIdem(t.Context(), "key-1", tok) {
		t.Fatal("fresh key must claim")
	}
	other, _ := st.IssueLink(t.Context(), "mac", "admin")
	if st.ClaimIdem(t.Context(), "key-1", other) {
		t.Fatal("live key must resist second claim")
	}
	got, ok := st.LookupIdem(t.Context(), "key-1")
	if !ok || got != tok {
		t.Fatalf("want %q live, got %q %v", tok, got, ok)
	}
}

func TestIdemTakeoverAfterClaim(t *testing.T) {
	st, _ := store.Open(t.Context(), ":memory:")
	defer st.Close()
	tok, _ := st.IssueLink(t.Context(), "mac", "admin")
	if !st.ClaimIdem(t.Context(), "key-1", tok) {
		t.Fatal("setup: fresh key must claim")
	}
	if _, ok := st.ConsumeLink(t.Context(), tok); !ok {
		t.Fatal("setup: token must consume")
	}
	if _, ok := st.LookupIdem(t.Context(), "key-1"); ok {
		t.Fatal("claimed token must miss")
	}
	fresh, _ := st.IssueLink(t.Context(), "mac", "admin")
	if !st.ClaimIdem(t.Context(), "key-1", fresh) {
		t.Fatal("dead key must allow takeover")
	}
	got, ok := st.LookupIdem(t.Context(), "key-1")
	if !ok || got != fresh {
		t.Fatalf("want %q live, got %q %v", fresh, got, ok)
	}
}

func TestIdemPersistsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	st, _ := store.Open(t.Context(), dir+"/i.db")
	tok, _ := st.IssueLink(t.Context(), "mac", "admin")
	if !st.ClaimIdem(t.Context(), "key-1", tok) {
		t.Fatal("setup: fresh key must claim")
	}
	st.Close()
	st2, _ := store.Open(t.Context(), dir+"/i.db")
	defer st2.Close()
	got, ok := st2.LookupIdem(t.Context(), "key-1")
	if !ok || got != tok {
		t.Fatalf("want persisted %q, got %q %v", tok, got, ok)
	}
}
