package boxadmin_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mfenderov/ocd/internal/boxadmin"
	"github.com/mfenderov/ocd/internal/store"
)

func postMint(t *testing.T, h http.Handler, key string) string {
	t.Helper()
	req := httptest.NewRequest("POST", "/admin/mint", nil)
	req.Header.Set("Authorization", "Bearer s3cr3t")
	req.Header.Set("Idempotency-Key", key)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
	}
	body, _ := io.ReadAll(rec.Result().Body)
	return strings.TrimSpace(string(body))
}

func TestSameIdempotencyKeyMintsOnce(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	calls := 0
	exec := func() (string, error) { calls++; return "https://oc.buyallmemes.com/auth/connect/abc", nil }
	h := boxadmin.RequireAdmin(st, "s3cr3t", boxadmin.MintHandler(st, exec, "https://oc-tap.buyallmemes.com/pair"))
	first := postMint(t, h, "key-1")
	second := postMint(t, h, "key-1")
	if first != second {
		t.Fatalf("want same URL, got %q vs %q", first, second)
	}
	if calls != 1 {
		t.Fatalf("want 1 exec, got %d", calls)
	}
}

func TestMissingIdempotencyKeyGets400(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	exec := func() (string, error) { return "https://oc.buyallmemes.com/auth/connect/abc", nil }
	h := boxadmin.RequireAdmin(st, "s3cr3t", boxadmin.MintHandler(st, exec, "https://oc-tap.buyallmemes.com/pair"))
	req := httptest.NewRequest("POST", "/admin/mint", nil)
	req.Header.Set("Authorization", "Bearer s3cr3t")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestNewIdempotencyKeyMintsFresh(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	calls := 0
	exec := func() (string, error) { calls++; return "https://oc.buyallmemes.com/auth/connect/abc", nil }
	h := boxadmin.RequireAdmin(st, "s3cr3t", boxadmin.MintHandler(st, exec, "https://oc-tap.buyallmemes.com/pair"))
	first := postMint(t, h, "key-1")
	second := postMint(t, h, "key-2")
	if first == second {
		t.Fatalf("want fresh URL, got same %q twice", first)
	}
	if calls != 2 {
		t.Fatalf("want 2 exec, got %d", calls)
	}
}

func TestClaimedKeyMintsFresh(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	calls := 0
	exec := func() (string, error) { calls++; return "https://oc.buyallmemes.com/auth/connect/abc", nil }
	h := boxadmin.RequireAdmin(st, "s3cr3t", boxadmin.MintHandler(st, exec, "https://oc-tap.buyallmemes.com/pair"))
	first := postMint(t, h, "key-1")
	tok := strings.TrimPrefix(first, "https://oc-tap.buyallmemes.com/pair?t=")
	if _, ok := st.ConsumeLink(tok); !ok {
		t.Fatalf("setup: first token must be consumable")
	}
	second := postMint(t, h, "key-1")
	if first == second {
		t.Fatalf("want fresh URL after claim, got same %q", first)
	}
	if calls != 2 {
		t.Fatalf("want 2 exec, got %d", calls)
	}
}
