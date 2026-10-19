package boxadmin_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mfenderov/ocd/internal/boxadmin"
	"github.com/mfenderov/ocd/internal/store"
)

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
}

func TestBadBearerGets401AndAuditRow(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	h := boxadmin.RequireAdmin(st, "s3cr3t", okHandler())
	req := httptest.NewRequest("POST", "/_oc/mint", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", rec.Code)
	}
	rows := st.RecentAudit(3)
	if len(rows) != 1 || rows[0].Action != "admin_denied" {
		t.Fatalf("want 1 admin_denied row, got %+v", rows)
	}
}

func TestMissingBearerGets401(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	h := boxadmin.RequireAdmin(st, "s3cr3t", okHandler())
	req := httptest.NewRequest("POST", "/_oc/mint", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", rec.Code)
	}
	rows := st.RecentAudit(3)
	if len(rows) != 1 || rows[0].Action != "admin_denied" {
		t.Fatalf("want 1 admin_denied row, got %+v", rows)
	}
}
