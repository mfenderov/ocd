package pair_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mfenderov/ocd/internal/pair"
	"github.com/mfenderov/ocd/internal/store"
)

func openStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	st.AddDevice("mac", "darwin")
	return st
}

func TestNoJWTGives401AndNoMint(t *testing.T) {
	t.Setenv("OCD_PAIR_OPEN", "")
	st := openStore(t)
	tok, _ := st.IssueLink("mac", "telegram")
	h := pair.Handler(st, func() (string, error) { return "LINK", nil })
	req := httptest.NewRequest("GET", "/pair?t="+tok, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", rec.Code)
	}
}

func TestTapMintsAndRedirectsOnce(t *testing.T) {
	t.Setenv("OCD_PAIR_OPEN", "1")
	st := openStore(t)
	tok, _ := st.IssueLink("mac", "telegram")
	calls := 0
	h := pair.Handler(st, func() (string, error) {
		calls++
		return "https://oc.buyallmemes.com/auth/connect/abc", nil
	})
	req := httptest.NewRequest("GET", "/pair?t="+tok, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusFound {
		t.Fatalf("want 302, got %d", rec.Code)
	}
	if calls != 1 {
		t.Fatalf("want 1 mint, got %d", calls)
	}
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, httptest.NewRequest("GET", "/pair?t="+tok, nil))
	if rec2.Code != http.StatusGone {
		t.Fatalf("second tap want 410, got %d", rec2.Code)
	}
	if calls != 1 {
		t.Fatalf("second tap must not re-mint, calls=%d", calls)
	}
}

func TestRawUAStored(t *testing.T) {
	t.Setenv("OCD_PAIR_OPEN", "1")
	ua := "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)"
	st := openStore(t)
	tok, _ := st.IssueLink("mac", "telegram")
	h := pair.Handler(st, func() (string, error) { return "https://x/y", nil })
	r := httptest.NewRequest("GET", "/pair?t="+tok, nil)
	r.Header.Set("User-Agent", ua)
	h.ServeHTTP(httptest.NewRecorder(), r)
	rows := st.RecentAudit(3)
	found := false
	for _, row := range rows {
		if row.Action == "consumed" && row.UA == ua {
			found = true
		}
	}
	if !found {
		t.Fatalf("want consumed row with raw UA, got %+v", rows)
	}
}

func TestMissingTokenIs400(t *testing.T) {
	t.Setenv("OCD_PAIR_OPEN", "1")
	st := openStore(t)
	h := pair.Handler(st, func() (string, error) { return "LINK", nil })
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/pair", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
}
