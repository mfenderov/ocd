package pair_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mfenderov/ocd/internal/pair"
	"github.com/mfenderov/ocd/internal/store"
)

func TestNoJWTGives401AndNoMint(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	st.AddDevice("mac", "darwin")
	h := pair.Handler(st, func() (string, error) { return "LINK", nil })
	req := httptest.NewRequest("GET", "/pair?device=mac", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", rec.Code)
	}
	if n := st.CountRecentMints("mac", 24*60*60*1_000_000_000); n != 0 {
		t.Fatalf("want 0 mints, got %d", n)
	}
}
