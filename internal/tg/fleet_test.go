package tg_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/mfenderov/ocd/internal/tg"
)

// stubFleetWorker serves the Worker endpoints the bot fleet commands need.
// It asserts the CLI bearer token travels on every request.
func stubFleetWorker(t *testing.T, backends string) *httptest.Server {
	t.Helper()
	now := time.Now().Unix()
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
			return
		}
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/backends":
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprintf(w, backends, now, now, now-3600)
		case r.Method == http.MethodPost && r.URL.Path == "/api/backends/home/link":
			w.Header().Set("Content-Type", "text/plain;charset=utf-8")
			_, _ = w.Write([]byte(`https://tap.example/?t=tok-1`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/backends/home/revoke":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"home","status":"revoked","epoch":2}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/revoke-all":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"results":[{"id":"home","status":"revoked","epoch":2},{"id":"mac","status":"tombstoned","epoch":3}]}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/audit":
			w.Header().Set("Content-Type", "application/json")
			if r.URL.Query().Get("box") == "empty" {
				_, _ = w.Write([]byte(`{"rows":[]}`))
				return
			}
			_, _ = w.Write([]byte(`{"rows":[
				{"box":"home","at":1699999900,"actor":"owner","action":"tapped","result":"ok","device":"dev","ip":"1.2.3.4","tainted":false},
				{"box":"mac","at":1699999901,"actor":"-","action":"-","result":"-","error":"sync","detail":"dial timeout","tainted":true,"last_seen":1699999901}
			]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	return httptest.NewServer(mux)
}

const fleetBackendsTmpl = `[
	{"id":"home","hostname":"home.example.com","epoch":1,"last_seq":7,"last_ts":1000,"last_seen":%d,"enrolled":1,"tombstoned":false},
	{"id":"mac","hostname":"mac.example.com","epoch":3,"last_seq":9,"last_ts":2000,"last_seen":%d,"enrolled":1,"tombstoned":true},
	{"id":"old","hostname":"old.example.com","epoch":1,"last_seq":5,"last_ts":900,"last_seen":%d,"enrolled":1,"tombstoned":false}
]`

func fleetEnv(t *testing.T, srv *httptest.Server) {
	t.Helper()
	t.Setenv("OCD_WORKER_URL", srv.URL)
	t.Setenv("OCD_FLEET_TOKEN", "test-token")
}

func TestFleetStatusListsBoxes(t *testing.T) {
	srv := stubFleetWorker(t, fleetBackendsTmpl)
	defer srv.Close()
	fleetEnv(t, srv)
	got, err := tg.FleetStatusText(context.Background())
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	for _, want := range []string{"home", "mac", "old", "ok", "tombstoned", "offline"} {
		if !strings.Contains(got, want) {
			t.Fatalf("status must mention %q, got:\n%s", want, got)
		}
	}
}

func TestFleetStatusEmpty(t *testing.T) {
	srv := stubFleetWorker(t, `[]`)
	defer srv.Close()
	fleetEnv(t, srv)
	got, err := tg.FleetStatusText(context.Background())
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !strings.Contains(got, "No boxes") {
		t.Fatalf("empty fleet must say so, got:\n%s", got)
	}
}

func TestFleetTokenUnset(t *testing.T) {
	srv := stubFleetWorker(t, `[]`)
	defer srv.Close()
	t.Setenv("OCD_WORKER_URL", srv.URL)
	t.Setenv("OCD_FLEET_TOKEN", "")
	got, err := tg.FleetStatusText(context.Background())
	if err != nil {
		t.Fatalf("unset token is a state, not an error: %v", err)
	}
	if !strings.Contains(got, "OCD_FLEET_TOKEN") {
		t.Fatalf("must name the missing env var, got:\n%s", got)
	}
}

func TestFleetLink(t *testing.T) {
	srv := stubFleetWorker(t, fleetBackendsTmpl)
	defer srv.Close()
	fleetEnv(t, srv)
	got, err := tg.FleetLinkText(context.Background(), "home")
	if err != nil {
		t.Fatalf("link: %v", err)
	}
	if !strings.Contains(got, "https://tap.example/?t=tok-1") || !strings.Contains(got, "home") {
		t.Fatalf("link must carry the tap URL for the box, got:\n%s", got)
	}
}

func TestFleetLinkMissingBox(t *testing.T) {
	srv := stubFleetWorker(t, fleetBackendsTmpl)
	defer srv.Close()
	fleetEnv(t, srv)
	got, err := tg.FleetLinkText(context.Background(), "")
	if err != nil {
		t.Fatalf("missing box is usage, not an error: %v", err)
	}
	if !strings.Contains(got, "/flink") {
		t.Fatalf("must show usage, got:\n%s", got)
	}
}

func TestFleetRevokeAsksConfirm(t *testing.T) {
	srv := stubFleetWorker(t, fleetBackendsTmpl)
	defer srv.Close()
	fleetEnv(t, srv)
	got, err := tg.FleetRevokeText(context.Background(), "home", false)
	if err != nil {
		t.Fatalf("unconfirmed revoke is a prompt, not an error: %v", err)
	}
	if !strings.Contains(got, "/frevoke home YES") {
		t.Fatalf("must show the confirm command, got:\n%s", got)
	}
}

func TestFleetRevokeConfirmed(t *testing.T) {
	srv := stubFleetWorker(t, fleetBackendsTmpl)
	defer srv.Close()
	fleetEnv(t, srv)
	got, err := tg.FleetRevokeText(context.Background(), "home", true)
	if err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if !strings.Contains(got, "home") || !strings.Contains(got, "revoked") {
		t.Fatalf("must report the revocation, got:\n%s", got)
	}
}

func TestFleetNukeAsksConfirm(t *testing.T) {
	srv := stubFleetWorker(t, fleetBackendsTmpl)
	defer srv.Close()
	fleetEnv(t, srv)
	got, err := tg.FleetNukeText(context.Background(), false)
	if err != nil {
		t.Fatalf("unconfirmed nuke is a prompt, not an error: %v", err)
	}
	if !strings.Contains(got, "/fnuke YES") {
		t.Fatalf("must show the confirm command, got:\n%s", got)
	}
}

func TestFleetNukeConfirmed(t *testing.T) {
	srv := stubFleetWorker(t, fleetBackendsTmpl)
	defer srv.Close()
	fleetEnv(t, srv)
	got, err := tg.FleetNukeText(context.Background(), true)
	if err != nil {
		t.Fatalf("nuke: %v", err)
	}
	if !strings.Contains(got, "home") || !strings.Contains(got, "mac") {
		t.Fatalf("must summarize per-box results, got:\n%s", got)
	}
}

func TestFleetAudit(t *testing.T) {
	srv := stubFleetWorker(t, fleetBackendsTmpl)
	defer srv.Close()
	fleetEnv(t, srv)
	got, err := tg.FleetAuditText(context.Background(), "", 10)
	if err != nil {
		t.Fatalf("audit: %v", err)
	}
	for _, want := range []string{"tapped", "home", "1.2.3.4"} {
		if !strings.Contains(got, want) {
			t.Fatalf("audit must mention %q, got:\n%s", want, got)
		}
	}
}

func TestFleetAuditEmpty(t *testing.T) {
	srv := stubFleetWorker(t, fleetBackendsTmpl)
	defer srv.Close()
	fleetEnv(t, srv)
	got, err := tg.FleetAuditText(context.Background(), "empty", 10)
	if err != nil {
		t.Fatalf("audit: %v", err)
	}
	if !strings.Contains(got, "No audit rows") {
		t.Fatalf("empty audit must say so, got:\n%s", got)
	}
}

func TestFleetEnrollCode(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/enroll" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		// The bot authenticates its issuance: the worker only trusts a
		// pending row (claimable by typing the code) when the request
		// carries the fleet token.
		if r.Header.Get("Authorization") != "Bearer test-token" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"pending","id":"mac"}`))
	}))
	defer srv.Close()
	t.Setenv("OCD_WORKER_URL", srv.URL)
	t.Setenv("OCD_FLEET_TOKEN", "test-token")
	got, err := tg.FleetEnrollCodeText(context.Background(), "mac", "")
	if err != nil {
		t.Fatalf("enrollcode: %v", err)
	}
	code, _ := body["enroll_token"].(string)
	if len(code) < 16 {
		t.Fatalf("code must be a strong secret, got %q", code)
	}
	if !strings.Contains(got, code) || !strings.Contains(got, "mac") {
		t.Fatalf("reply must carry the code and the box name, got:\n%s", got)
	}
	if !strings.Contains(got, code) {
		t.Fatalf("reply must carry the code, got:\n%s", got)
	}
	if strings.Contains(got, "--enroll-code") {
		t.Fatalf("reply must not carry flags, got:\n%s", got)
	}
	if body["hostname"] != "oc-tap-mac.buyallmemes.com" {
		t.Fatalf("default tap hostname must be oc-tap-<box>, got %v", body["hostname"])
	}
	if _, hasAdmin := body["admin_token"]; hasAdmin {
		t.Fatal("issuer must not seal an admin it cannot know")
	}
}

func TestFleetEnrollCodeUsage(t *testing.T) {
	t.Setenv("OCD_FLEET_TOKEN", "test-token")
	got, err := tg.FleetEnrollCodeText(context.Background(), "", "")
	if err != nil {
		t.Fatalf("missing box is usage, not error: %v", err)
	}
	if !strings.Contains(got, "/enrollcode") {
		t.Fatalf("must show usage, got:\n%s", got)
	}
}
