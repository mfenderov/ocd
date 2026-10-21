package boxadmin_test

import (
	"bytes"
	"context"
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

// postAdmin posts to the box admin API with the admin bearer.
func postAdmin(t *testing.T, h http.Handler, body any) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatalf("encode body: %v", err)
		}
	}
	req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/_oc/revoke", &buf)
	req.Header.Set("Authorization", "Bearer s3cr3t")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// revokeExec records the argv of every exec the revoke runs.
type revokeExec struct {
	argv [][]string
}

func (e *revokeExec) run(_ context.Context, name string, args ...string) (string, error) {
	e.argv = append(e.argv, append([]string{name}, args...))
	return "", nil
}

func TestRevokeBumpsEpoch(t *testing.T) {
	st, _ := store.Open(t.Context(), ":memory:")
	defer st.Close()
	exec := &revokeExec{}
	h := boxadmin.RequireAdmin(st, "s3cr3t", boxadmin.RevokeHandler(st, exec.run))
	rec := postAdmin(t, h, map[string]bool{"confirm": true})
	if rec.Code != 200 {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if got := st.PasswordEpoch(t.Context()); got != 1 {
		t.Fatalf("want epoch 1, got %d", got)
	}
	var resp struct {
		Epoch int `json:"epoch"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || resp.Epoch != 1 {
		t.Fatalf("want {\"epoch\":1}, got %q (err=%v)", rec.Body.String(), err)
	}
}

// The revoke runs a fixed argv: nothing request-derived reaches the
// command line.
func TestRevokeRunsAFixedArgv(t *testing.T) {
	st, _ := store.Open(t.Context(), ":memory:")
	defer st.Close()
	exec := &revokeExec{}
	h := boxadmin.RequireAdmin(st, "s3cr3t", boxadmin.RevokeHandler(st, exec.run))
	postAdmin(t, h, map[string]bool{"confirm": true})
	if len(exec.argv) < 2 {
		t.Fatalf("want at least 2 exec calls, got %v", exec.argv)
	}
	assertSetPasswordArgv(t, exec.argv[0])
	assertStartServiceArgv(t, exec.argv[1])
}

// assertSetPasswordArgv checks the argv that rotates the password.
func assertSetPasswordArgv(t *testing.T, argv []string) {
	t.Helper()
	if len(argv) != 5 || argv[0] != "opencode" || argv[1] != "service" ||
		argv[2] != "set" || argv[3] != "password" || argv[4] == "" {
		t.Fatalf("unexpected set argv: %v", argv)
	}
}

// assertStartServiceArgv checks the argv that restarts the service.
func assertStartServiceArgv(t *testing.T, argv []string) {
	t.Helper()
	if len(argv) != 3 || argv[0] != "opencode" || argv[1] != "service" || argv[2] != "start" {
		t.Fatalf("unexpected start argv: %v", argv)
	}
}

func TestRevokeBodyIsSnakeCaseEpoch(t *testing.T) {
	st, _ := store.Open(t.Context(), ":memory:")
	defer st.Close()
	exec := func(_ context.Context, name string, args ...string) (string, error) {
		return "", nil
	}
	h := boxadmin.RequireAdmin(st, "s3cr3t", boxadmin.RevokeHandler(st, exec))
	rec := postAdmin(t, h, map[string]bool{"confirm": true})
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
	st, _ := store.Open(t.Context(), ":memory:")
	defer st.Close()
	calls := 0
	exec := func(_ context.Context, name string, args ...string) (string, error) {
		calls++
		return "", nil
	}
	h := boxadmin.RequireAdmin(st, "s3cr3t", boxadmin.RevokeHandler(st, exec))
	rec := postAdmin(t, h, map[string]bool{})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d: %s", rec.Code, rec.Body.String())
	}
	if calls != 0 {
		t.Fatalf("want 0 exec calls, got %d", calls)
	}
	if got := st.PasswordEpoch(t.Context()); got != 0 {
		t.Fatalf("want epoch 0, got %d", got)
	}
}

func TestRevokeExecFailureDoesNotBumpEpoch(t *testing.T) {
	st, _ := store.Open(t.Context(), ":memory:")
	defer st.Close()
	exec := func(_ context.Context, name string, args ...string) (string, error) {
		return "", errTestRevoke
	}
	h := boxadmin.RequireAdmin(st, "s3cr3t", boxadmin.RevokeHandler(st, exec))
	rec := postAdmin(t, h, map[string]bool{"confirm": true})
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("want 502, got %d: %s", rec.Code, rec.Body.String())
	}
	if got := st.PasswordEpoch(t.Context()); got != 0 {
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
			st, _ := store.Open(t.Context(), ":memory:")
			defer st.Close()
			calls := 0
			exec := func(_ context.Context, name string, args ...string) (string, error) {
				calls++
				return "", nil
			}
			h := boxadmin.RequireAdmin(st, "s3cr3t", boxadmin.RevokeHandler(st, exec))
			req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/_oc/revoke", strings.NewReader(tc.raw))
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
			if got := st.PasswordEpoch(t.Context()); got != 0 {
				t.Fatalf("want epoch 0, got %d", got)
			}
		})
	}
}
