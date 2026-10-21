package boxadmin_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/mfenderov/ocd/internal/boxadmin"
	"github.com/mfenderov/ocd/internal/store"
)

// The brain relays the box's OpenCode status when the owner asks whether
// the editor is up, so the handler must answer the URL of the running
// service.
func TestStatusHandler(t *testing.T) {
	st, err := store.Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	exec := func(ctx context.Context, name string, args ...string) (string, error) {
		if name == "opencode" && len(args) == 2 && args[0] == "service" && args[1] == "status" {
			return "http://127.0.0.1:49374\n", nil
		}
		return "", nil
	}

	h := boxadmin.StatusHandler(st, exec)
	req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/_oc/status", nil)
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
	st, err := store.Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	exec := func(ctx context.Context, name string, args ...string) (string, error) {
		return "http://127.0.0.1:49374\n", nil
	}

	h := boxadmin.StatusHandler(st, exec)
	req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/_oc/status", nil)
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

// The exec must run under a deadline: a hung opencode would otherwise
// keep this handler's goroutine forever.
func TestStatusExecRunsUnderADeadline(t *testing.T) {
	st, err := store.Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	var deadline time.Time
	var hasDeadline bool
	exec := func(ctx context.Context, name string, args ...string) (string, error) {
		deadline, hasDeadline = ctx.Deadline()
		return "http://127.0.0.1:49374\n", nil
	}

	h := boxadmin.StatusHandler(st, exec)
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/_oc/status", nil))

	if !hasDeadline {
		t.Fatal("the exec ran without a deadline: a hung opencode would hold the handler forever")
	}
	if left := time.Until(deadline); left <= 0 || left > 10*time.Second {
		t.Fatalf("want a deadline inside the status timeout, got %s", left)
	}
}

// The brain's deadline cancels the Worker's fetch, not the box's exec.
// When the caller goes away the exec must follow, so the box does not
// keep a goroutine that nobody waits for.
func TestStatusExecStopsWhenTheCallerLeaves(t *testing.T) {
	st, err := store.Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	stopped := make(chan struct{}, 1)
	exec := func(ctx context.Context, name string, args ...string) (string, error) {
		<-ctx.Done()
		select {
		case stopped <- struct{}{}:
		default:
		}
		return "", ctx.Err()
	}

	h := boxadmin.StatusHandler(st, exec)
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/_oc/status", nil).WithContext(ctx)
	done := make(chan struct{})
	go func() {
		h.ServeHTTP(httptest.NewRecorder(), req)
		close(done)
	}()

	cancel() // the caller leaves.

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the status handler did not stop when the caller left")
	}
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("the exec was not stopped when the caller left")
	}
}
