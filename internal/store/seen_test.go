package store_test

import (
	"testing"

	"github.com/mfenderov/ocd/internal/store"
)

func TestSeenClients(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	st.AuditUA("web:x", "tapped", "", "1.1.1.1 · other", "ok", "curl/8.0")
	st.AuditUA("web:x", "consumed", "", "1.1.1.1 · other", "ok", "curl/8.0")
	st.AuditUA("web:x", "link_issued", "", "", "ok", "")
	got := st.SeenClients()
	if len(got) != 1 || got[0].Count != 2 || got[0].UA != "curl/8.0" {
		t.Fatalf("want 1 client x2 curl, got %+v", got)
	}
}
