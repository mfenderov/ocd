package onboard

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// lockedBuffer is a mutex-guarded writer: the spinner writes to it from
// the program's goroutine while the test reads it.
type lockedBuffer struct {
	mu sync.Mutex
	sb strings.Builder
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.sb.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.sb.String()
}

// The spinner shows the status the onboarding reports.
func TestSpinnerModelShowsTheStatus(t *testing.T) {
	m := spinnerModel{status: "starting…"}

	next, _ := m.Update(statusMsg("writing the env file"))

	got, ok := next.(spinnerModel)
	if !ok {
		t.Fatalf("want a spinner model, got %T", next)
	}
	if got.status != "writing the env file" {
		t.Fatalf("the status must be shown, got %q", got.status)
	}
}

// The onboarding is over: the spinner quits and keeps the result.
func TestSpinnerModelQuitsWhenTheOnboardingIsDone(t *testing.T) {
	m := spinnerModel{}
	want := Result{TunnelID: "7ed965a2-9828-46f6-851e-24cf1b9fedf6"}

	next, cmd := m.Update(doneMsg{res: want})

	got, ok := next.(spinnerModel)
	if !ok {
		t.Fatalf("want a spinner model, got %T", next)
	}
	if !got.done {
		t.Fatal("the spinner must know it is done")
	}
	if got.res.TunnelID != want.TunnelID {
		t.Fatalf("the result must survive, got %+v", got.res)
	}
	if cmd == nil {
		t.Fatal("a finished onboarding must quit the program")
	}
}

// The operator aborts: the spinner quits and cancels the onboarding.
func TestSpinnerModelAbortsOnEsc(t *testing.T) {
	cancelled := false
	m := spinnerModel{cancel: func() { cancelled = true }}

	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEsc})

	if !cancelled {
		t.Fatal("esc must abort the onboarding")
	}
	if cmd == nil {
		t.Fatal("an aborted onboarding must quit the program")
	}
}

// A key the operator did not press to abort leaves the spinner alone.
func TestSpinnerModelIgnoresOtherKeys(t *testing.T) {
	cancelled := false
	m := spinnerModel{cancel: func() { cancelled = true }}

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'x'}})

	if cancelled {
		t.Fatal("a key that does not abort must not cancel the onboarding")
	}
	got, ok := next.(spinnerModel)
	if !ok {
		t.Fatalf("want a spinner model, got %T", next)
	}
	if got.done {
		t.Fatal("a key that does not abort must not end the onboarding")
	}
}

// The spinner runs the onboarding to the end: the env file is written
// and the result comes back.
func TestRunSpinnerRunsTheOnboarding(t *testing.T) {
	dir := t.TempDir()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"enrolled"}`))
	}))
	t.Cleanup(srv.Close)
	old := RestartBox
	RestartBox = func(context.Context, string, bool) RestartResult { return RestartResult{} }
	t.Cleanup(func() { RestartBox = old })

	cfg := Config{
		BoxID: "home", WorkerURL: srv.URL, PublicHost: TapHost("home"),
		PairURL: "https://" + UIHost("home"),
		EnvPath: filepath.Join(dir, "env"),
		DBPath:  filepath.Join(dir, "ocd.db"),
		Timeout: 10 * 1e9,
	}
	var out lockedBuffer
	opts := []tea.ProgramOption{tea.WithInput(strings.NewReader("")), tea.WithOutput(&out)}

	res, err := runSpinner(context.Background(), cfg, opts)

	if err != nil {
		t.Fatalf("spinner: %v", err)
	}
	if res.Restart.DaemonRunsAsService {
		t.Fatal("no service ran the daemon: the restart says so")
	}
	vals, err := LoadEnvFile(cfg.EnvPath)
	if err != nil {
		t.Fatalf("the onboarding must write the env file: %v", err)
	}
	if vals["OCD_BOX_ID"] != "home" {
		t.Fatalf("the env file must hold the box, got %q", vals["OCD_BOX_ID"])
	}
}
