package fleet_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mfenderov/ocd/internal/fleet"
)

// The heartbeat sender's canonical OCD_WORKER_URL ends in /api/heartbeat.
// The fleet client must resolve API paths under the origin either way;
// otherwise every fleet call 404s (bot /fleet failure, 2026-10-18).
func TestClientTrimsHeartbeatSuffix(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	t.Setenv("OCD_WORKER_URL", srv.URL+"/api/heartbeat")
	t.Setenv("OCD_FLEET_TOKEN", "test-token")
	c, err := fleet.NewClientFromEnv()
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	if _, err := c.Backends(context.Background()); err != nil {
		t.Fatalf("backends: %v", err)
	}
	if gotPath != "/api/backends" {
		t.Fatalf("fleet path resolved to %q, want /api/backends", gotPath)
	}
}
