package mint_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/mfenderov/ocd/internal/mint"
	"github.com/mfenderov/ocd/internal/store"
)

func TestMintRateCap(t *testing.T) {
	st, _ := store.Open(t.Context(), ":memory:")
	defer st.Close()
	st.AddDevice(t.Context(), "mac", "darwin")
	calls := 0
	exec := func(context.Context) (string, error) { calls++; return "https://oc.buyallmemes.com/pair/abc", nil }
	for i := range 5 {
		if _, err := mint.Mint(t.Context(), st, exec, "mac", "tui"); err != nil {
			t.Fatalf("mint %d: %v", i, err)
		}
	}
	if _, err := mint.Mint(t.Context(), st, exec, "mac", "tui"); !errors.Is(err, mint.ErrRateLimited) {
		t.Fatalf("want ErrRateLimited, got %v calls=%d", err, calls)
	}
	if calls != 5 {
		t.Fatalf("want 5 exec calls, got %d", calls)
	}
}

// A pre-flight proves pairing works; it is not a session. The session is
// the tap, so a pre-flight must not spend a session slot.
func TestPreflightDoesNotSpendASession(t *testing.T) {
	st, _ := store.Open(t.Context(), ":memory:")
	defer st.Close()
	calls := 0
	exec := func(context.Context) (string, error) { calls++; return "https://oc.buyallmemes.com/pair/abc", nil }
	for i := range 6 {
		if _, err := mint.Preflight(t.Context(), st, exec, "admin"); err != nil {
			t.Fatalf("preflight %d: %v", i, err)
		}
	}
	if got := st.CountRecentMints(t.Context(), "", time.Hour); got != 0 {
		t.Fatalf("a pre-flight is not a session: want 0 counted, got %d", got)
	}
	if calls != 6 {
		t.Fatalf("want 6 exec calls, got %d", calls)
	}
}

// The pre-flight checks the budget of the sessions already delivered: a
// spent budget refuses the link, and the exec never runs.
func TestPreflightRefusesWhenTheSessionBudgetIsSpent(t *testing.T) {
	st, _ := store.Open(t.Context(), ":memory:")
	defer st.Close()
	exec := func(context.Context) (string, error) { return "https://oc.buyallmemes.com/pair/abc", nil }
	for i := range 5 {
		if _, err := mint.Mint(t.Context(), st, exec, "admin", "web"); err != nil {
			t.Fatalf("mint %d: %v", i, err)
		}
	}
	calls := 0
	pre := func(context.Context) (string, error) { calls++; return "https://oc.buyallmemes.com/pair/abc", nil }
	if _, err := mint.Preflight(t.Context(), st, pre, "admin"); !errors.Is(err, mint.ErrRateLimited) {
		t.Fatalf("want ErrRateLimited, got %v", err)
	}
	if calls != 0 {
		t.Fatalf("a refused link must not run the exec, calls=%d", calls)
	}
}

// A pre-flight and the tap that follows it are one session, not two.
func TestPreflightAndTapAreOneSession(t *testing.T) {
	st, _ := store.Open(t.Context(), ":memory:")
	defer st.Close()
	exec := func(context.Context) (string, error) { return "https://oc.buyallmemes.com/pair/abc", nil }
	if _, err := mint.Preflight(t.Context(), st, exec, "admin"); err != nil {
		t.Fatalf("preflight: %v", err)
	}
	if _, err := mint.Mint(t.Context(), st, exec, "admin", "web"); err != nil {
		t.Fatalf("mint: %v", err)
	}
	if got := st.CountRecentMints(t.Context(), "", time.Hour); got != 1 {
		t.Fatalf("want 1 session counted, got %d", got)
	}
}

func TestParseLinkStripsQR(t *testing.T) {
	raw := "\n  Open a link to connect. Links work once and expire in 5 minutes.\n\n" +
		"  https://oc.buyallmemes.com/auth/connect/4k5uObGFoxt0380Xydaq9Q\n\n  ███████\n  ██ QR JUNK ██\n"
	got := mint.ParseLink(raw)
	want := "https://oc.buyallmemes.com/auth/connect/4k5uObGFoxt0380Xydaq9Q"
	if got != want {
		t.Fatalf("want %q, got %q", want, got)
	}
}

func TestParseLinkEmpty(t *testing.T) {
	if got := mint.ParseLink("no url here"); got != "" {
		t.Fatalf("want empty, got %q", got)
	}
}
