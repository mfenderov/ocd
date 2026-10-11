package boxadmin_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mfenderov/ocd/internal/boxadmin"
	"github.com/mfenderov/ocd/internal/store"
)

func TestPresenceShape(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	t.Setenv("OCD_BOX_ID", "box-7")
	h := boxadmin.RequireAdmin(st, "s3cr3t", boxadmin.PresenceHandler(st))
	req := httptest.NewRequest("GET", "/admin/presence", nil)
	req.Header.Set("Authorization", "Bearer s3cr3t")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode presence: %v", err)
	}
	for _, key := range []string{"id", "epoch", "version", "taps_24h"} {
		if _, ok := body[key]; !ok {
			t.Fatalf("want key %q present, got %v", key, body)
		}
	}
	if body["id"] != "box-7" {
		t.Fatalf("want id box-7, got %v", body["id"])
	}
	if body["version"] != "0.3.0" {
		t.Fatalf("want version 0.3.0, got %v", body["version"])
	}
	// Box id is read at request time, not handler construction time.
	t.Setenv("OCD_BOX_ID", "box-8")
	req2 := httptest.NewRequest("GET", "/admin/presence", nil)
	req2.Header.Set("Authorization", "Bearer s3cr3t")
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, req2)
	var body2 map[string]any
	if err := json.Unmarshal(rec2.Body.Bytes(), &body2); err != nil {
		t.Fatalf("decode presence: %v", err)
	}
	if body2["id"] != "box-8" {
		t.Fatalf("want request-time id box-8, got %v", body2["id"])
	}
}

func TestAuditCapsN(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	for i := range 250 {
		st.Audit(fmt.Sprintf("actor-%d", i), "tapped", "", "127.0.0.1", "ok")
	}
	h := boxadmin.RequireAdmin(st, "s3cr3t", boxadmin.AuditHandler(st))
	req := httptest.NewRequest("GET", "/admin/audit?n=5000", nil)
	req.Header.Set("Authorization", "Bearer s3cr3t")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var rows []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &rows); err != nil {
		t.Fatalf("decode audit: %v", err)
	}
	if len(rows) > 200 {
		t.Fatalf("want ≤200 rows, got %d", len(rows))
	}
	if len(rows) != 200 {
		t.Fatalf("want capped 200 rows, got %d", len(rows))
	}
	// Default (no n) returns 50.
	reqDefault := httptest.NewRequest("GET", "/admin/audit", nil)
	reqDefault.Header.Set("Authorization", "Bearer s3cr3t")
	recDefault := httptest.NewRecorder()
	h.ServeHTTP(recDefault, reqDefault)
	var defaultRows []map[string]any
	if err := json.Unmarshal(recDefault.Body.Bytes(), &defaultRows); err != nil {
		t.Fatalf("decode audit: %v", err)
	}
	if len(defaultRows) != 50 {
		t.Fatalf("want default 50 rows, got %d", len(defaultRows))
	}
}
