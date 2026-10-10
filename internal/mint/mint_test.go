package mint_test

import (
	"errors"
	"testing"

	"github.com/mfenderov/ocd/internal/mint"
	"github.com/mfenderov/ocd/internal/store"
)

func TestMintRateCap(t *testing.T) {
	st, _ := store.Open(":memory:")
	defer st.Close()
	st.AddDevice("mac", "darwin")
	calls := 0
	exec := func() (string, error) { calls++; return "https://oc.buyallmemes.com/pair/abc", nil }
	for i := 0; i < 5; i++ {
		if _, err := mint.Mint(st, exec, "mac", "tui"); err != nil {
			t.Fatalf("mint %d: %v", i, err)
		}
	}
	if _, err := mint.Mint(st, exec, "mac", "tui"); !errors.Is(err, mint.ErrRateLimited) {
		t.Fatalf("want ErrRateLimited, got %v calls=%d", err, calls)
	}
	if calls != 5 {
		t.Fatalf("want 5 exec calls, got %d", calls)
	}
}
