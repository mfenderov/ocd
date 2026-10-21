package boxadmin_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mfenderov/ocd/internal/boxadmin"
	"github.com/mfenderov/ocd/internal/store"
)

func TestMintWritesAuditRows(t *testing.T) {
	st, _ := store.Open(t.Context(), ":memory:")
	defer st.Close()
	exec := func(context.Context) (string, error) { return "https://oc.buyallmemes.com/auth/connect/abc", nil }
	h := boxadmin.RequireAdmin(st, "s3cr3t", boxadmin.MintHandler(st, exec, "https://oc-tap.buyallmemes.com/pair"))
	postMint(t, h, "audit-ok")
	rows := st.RecentAudit(t.Context(), 5)
	found := false
	for _, r := range rows {
		if r.Action == "link_issued" {
			found = true
		}
	}
	if !found {
		t.Fatalf("want link_issued audit row, got %+v", rows)
	}
}

func TestMintFailureWritesAuditAndKillsToken(t *testing.T) {
	st, _ := store.Open(t.Context(), ":memory:")
	defer st.Close()
	exec := func(context.Context) (string, error) { return "", errors.New("boom") }
	h := boxadmin.RequireAdmin(st, "s3cr3t", boxadmin.MintHandler(st, exec, "https://oc-tap.buyallmemes.com/pair"))
	req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/admin/mint", nil)
	req.Header.Set("Authorization", "Bearer s3cr3t")
	req.Header.Set("Idempotency-Key", "audit-fail")
	req.Header.Set("User-Agent", "ocd-fixpass/1.0")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("want 502, got %d", rec.Code)
	}
	rows := st.RecentAudit(t.Context(), 5)
	foundFail, foundUA := false, false
	for _, r := range rows {
		if r.Action == "mint_failed" {
			foundFail = true
			if r.UA == "ocd-fixpass/1.0" {
				foundUA = true
			}
		}
	}
	if !foundFail || !foundUA {
		t.Fatalf("want mint_failed row with UA, got %+v", rows)
	}
	if _, ok := st.LookupIdem(t.Context(), "audit-fail"); ok {
		t.Fatal("failed mint token must not stay live")
	}
}
