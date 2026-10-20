package boxadmin_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mfenderov/ocd/internal/boxadmin"
	"github.com/mfenderov/ocd/internal/store"
)

// The brain relays the box's OpenCode status when the owner asks whether
// the editor is up, so the handler must answer the URL of the running
// service.
func TestStatusHandler(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	exec := func(name string, args ...string) (string, error) {
		if name == "opencode" && len(args) == 2 && args[0] == "service" && args[1] == "status" {
			return "http://127.0.0.1:49374\n", nil
		}
		return "", nil
	}

	h := boxadmin.StatusHandler(st, exec)
	req := httptest.NewRequest("GET", "/_oc/status", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "http://127.0.0.1:49374") {
		t.Fatalf("want the service URL in the body, got %q", rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/plain" {
		t.Fatalf("want text/plain, got %q", ct)
	}
}

// The status is the same line the Go bot prints, so the brain and the
// bot never disagree about what the box is doing.
func TestStatusHandlerMatchesTheBotLine(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	exec := func(name string, args ...string) (string, error) {
		return "http://127.0.0.1:49374\n", nil
	}

	h := boxadmin.StatusHandler(st, exec)
	req := httptest.NewRequest("GET", "/_oc/status", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	body := rec.Body.String()
	if !strings.HasPrefix(body, "service=http://127.0.0.1:49374") {
		t.Fatalf("want the service line, got %q", body)
	}
	if !strings.Contains(body, "devices=0") {
		t.Fatalf("want the device count in the line, got %q", body)
	}
}
