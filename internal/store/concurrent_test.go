package store

import (
	"path/filepath"
	"sync"
	"testing"
)

// Two stores on one file — the daemon's and the CLI's — write at the
// same time. The loser of the race must wait for the lock, not fail:
// SQLITE_BUSY costs a row.
func TestTwoStoresCanWriteAtTheSameTime(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ocd.db")
	first, err := Open(t.Context(), path)
	if err != nil {
		t.Fatalf("open the first store: %v", err)
	}
	defer first.Close()
	second, err := Open(t.Context(), path)
	if err != nil {
		t.Fatalf("open the second store: %v", err)
	}
	defer second.Close()

	var wg sync.WaitGroup
	for range 20 {
		wg.Add(2)
		go func() {
			defer wg.Done()
			first.Audit(t.Context(), "a", "tapped", "device", "127.0.0.1", "ok")
		}()
		go func() {
			defer wg.Done()
			second.Audit(t.Context(), "b", "tapped", "device", "127.0.0.2", "ok")
		}()
	}
	wg.Wait()

	rows := first.RecentAudit(t.Context(), 100)
	if len(rows) != 40 {
		t.Fatalf("want every row to have landed, got %d of 40", len(rows))
	}
}
