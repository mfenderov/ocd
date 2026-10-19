package boxadmin_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mfenderov/ocd/internal/boxadmin"
	"github.com/mfenderov/ocd/internal/store"
)

var errTestRevoke = errors.New("service down")

func postAdmin(t *testing.T, h http.Handler, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatalf("encode body: %v", err)
		}
	}
	req := httptest.NewRequest("POST", path, &buf)
	req.Header.Set("Authorization", "Bearer s3cr3t")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestRevokeBumpsEpochAndFixedArgv(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	var argv [][]string
	exec := func(name string, args ...string) (string, error) {
		argv = append(argv, append([]string{name}, args...))
		return "", nil
	}
	h := boxadmin.RequireAdmin(st, "s3cr3t", boxadmin.RevokeHandler(st, exec))
	rec := postAdmin(t, h, "/_oc/revoke", map[string]bool{"confirm": true})
	if rec.Code != 200 {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if got := st.PasswordEpoch(); got != 1 {
		t.Fatalf("want epoch 1, got %d", got)
	}
	var resp struct {
		Epoch int `json:"epoch"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || resp.Epoch != 1 {
		t.Fatalf("want {\"epoch\":1}, got %q (err=%v)", rec.Body.String(), err)
	}
	if len(argv) < 2 {
		t.Fatalf("want at least 2 exec calls, got %v", argv)
	}
	if argv[0][1] != "service" || argv[0][2] != "set" {
		t.Fatalf("unexpected argv: %v", argv)
	}
	// Exact fixed argv: nothing request-derived.
	if len(argv[0]) != 5 || argv[0][0] != "opencode" || argv[0][3] != "password" || argv[0][4] == "" {
		t.Fatalf("unexpected set argv: %v", argv[0])
	}
	if len(argv[1]) != 3 || argv[1][0] != "opencode" || argv[1][1] != "service" || argv[1][2] != "start" {
		t.Fatalf("unexpected start argv: %v", argv[1])
	}
}

func TestRevokeBodyIsSnakeCaseEpoch(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	exec := func(name string, args ...string) (string, error) {
		return "", nil
	}
	h := boxadmin.RequireAdmin(st, "s3cr3t", boxadmin.RevokeHandler(st, exec))
	rec := postAdmin(t, h, "/_oc/revoke", map[string]bool{"confirm": true})
	if rec.Code != 200 {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode revoke: %v", err)
	}
	if len(body) != 1 {
		t.Fatalf("want exact keys {epoch}, got %v", body)
	}
	epoch, ok := body["epoch"]
	if !ok {
		t.Fatalf("want exact keys {epoch}, got %v", body)
	}
	if epoch != float64(1) {
		t.Fatalf("want epoch 1, got %v", body)
	}
}

func TestRevokeMissingConfirmGets400(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	calls := 0
	exec := func(name string, args ...string) (string, error) {
		calls++
		return "", nil
	}
	h := boxadmin.RequireAdmin(st, "s3cr3t", boxadmin.RevokeHandler(st, exec))
	rec := postAdmin(t, h, "/_oc/revoke", map[string]bool{})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d: %s", rec.Code, rec.Body.String())
	}
	if calls != 0 {
		t.Fatalf("want 0 exec calls, got %d", calls)
	}
	if got := st.PasswordEpoch(); got != 0 {
		t.Fatalf("want epoch 0, got %d", got)
	}
}

func TestRevokeExecFailureDoesNotBumpEpoch(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	exec := func(name string, args ...string) (string, error) {
		return "", errTestRevoke
	}
	h := boxadmin.RequireAdmin(st, "s3cr3t", boxadmin.RevokeHandler(st, exec))
	rec := postAdmin(t, h, "/_oc/revoke", map[string]bool{"confirm": true})
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("want 502, got %d: %s", rec.Code, rec.Body.String())
	}
	if got := st.PasswordEpoch(); got != 0 {
		t.Fatalf("want epoch 0, got %d", got)
	}
}

func TestRevokeNonTrueConfirmGets400(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{"string yes (brief snippet value)", `{"confirm": "yes"}`},
		{"explicit false", `{"confirm": false}`},
		{"malformed JSON", `{"confirm":`},
		{"empty body", ``},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			st, _ := store.Open(":memory:")
			defer st.Close()
			calls := 0
			exec := func(name string, args ...string) (string, error) {
				calls++
				return "", nil
			}
			h := boxadmin.RequireAdmin(st, "s3cr3t", boxadmin.RevokeHandler(st, exec))
			req := httptest.NewRequest("POST", "/_oc/revoke", strings.NewReader(tc.raw))
			req.Header.Set("Authorization", "Bearer s3cr3t")
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("want 400, got %d: %s", rec.Code, rec.Body.String())
			}
			if calls != 0 {
				t.Fatalf("want 0 exec calls, got %d", calls)
			}
			if got := st.PasswordEpoch(); got != 0 {
				t.Fatalf("want epoch 0, got %d", got)
			}
		})
	}
}
