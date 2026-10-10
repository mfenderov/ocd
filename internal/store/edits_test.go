package store_test

import (
	"testing"

	"github.com/mfenderov/ocd/internal/store"
)

func TestLinkMessageTracking(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	tok, _ := st.IssueLink("mac", "telegram")
	if err := st.SetLinkMessage(tok, 123, 456); err != nil {
		t.Fatal(err)
	}
	pending := st.PendingEdits()
	if len(pending) != 0 {
		t.Fatalf("fresh link needs no edit, got %+v", pending)
	}
	if _, ok := st.ConsumeLink(tok); !ok {
		t.Fatal("consume must succeed")
	}
	pending = st.PendingEdits()
	if len(pending) != 1 || pending[0].MessageID != 456 || pending[0].Note != "used" {
		t.Fatalf("want 1 used edit, got %+v", pending)
	}
	st.MarkEdited(tok)
	if len(st.PendingEdits()) != 0 {
		t.Fatal("marked edit must clear")
	}
}
