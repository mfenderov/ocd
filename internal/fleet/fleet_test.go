package fleet_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mfenderov/ocd/internal/fleet"
)

// stubWorker is an httptest stand-in for the fleet Worker API. It records
// hits and auth headers so tests pin the request contract.
type stubWorker struct {
	t      *testing.T
	mu     sync.Mutex
	hits   map[string]int
	auths  []string
	bodies map[string]string
}

func newStubWorker(t *testing.T) *stubWorker {
	return &stubWorker{t: t, hits: map[string]int{}, bodies: map[string]string{}}
}

func (s *stubWorker) record(r *http.Request) string {
	raw, _ := io.ReadAll(r.Body)
	s.mu.Lock()
	defer s.mu.Unlock()
	key := r.Method + " " + r.URL.RequestURI()
	s.hits[key]++
	s.auths = append(s.auths, r.Header.Get("Authorization"))
	s.bodies[key] = string(raw)
	return string(raw)
}

func (s *stubWorker) hitsFor(key string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.hits[key]
}

func (s *stubWorker) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := s.record(r)
		if r.Header.Get("Authorization") != "Bearer test-token" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
			return
		}
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/backends":
			w.Header().Set("Content-Type", "application/json")
			// Clock-relative rows so the CLI's offline inference is
			// deterministic: box-1 fresh, box-2 tombstoned, box-3 stale.
			now := time.Now().Unix()
			_, _ = fmt.Fprintf(w, `[
				{"id":"box-1","hostname":"box-1.example.com","epoch":1,"last_seq":7,"last_ts":1000,"last_seen":%d,"enrolled":1,"tombstoned":false},
				{"id":"box-2","hostname":"box-2.example.com","epoch":3,"last_seq":9,"last_ts":2000,"last_seen":%d,"enrolled":1,"tombstoned":true},
				{"id":"box-3","hostname":"box-3.example.com","epoch":1,"last_seq":5,"last_ts":900,"last_seen":%d,"enrolled":1,"tombstoned":false}
			]`, now, now, now-3600)
		case r.Method == http.MethodPost && r.URL.Path == "/api/backends/box-1/link":
			w.Header().Set("Content-Type", "text/plain;charset=utf-8")
			_, _ = w.Write([]byte(`https://proxy.example/?t=tok-1`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/backends/box-1/revoke":
			var req map[string]any
			_ = json.Unmarshal([]byte(body), &req)
			if req["confirm"] != true {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"error":"confirm_required"}`))
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"box-1","status":"revoked","epoch":2}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/revoke-all":
			var req map[string]any
			_ = json.Unmarshal([]byte(body), &req)
			if req["confirm"] != true {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"error":"confirm_required"}`))
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"results":[
				{"id":"box-1","status":"revoked","epoch":2},
				{"id":"box-2","status":"tombstoned","epoch":3,"detail":"box_unreachable"}
			]}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/audit":
			q := r.URL.Query()
			rows := `[
				{"box":"box-1","at":1699999900,"actor":"owner","action":"tapped","device":"dev","ip":"127.0.0.1","result":"ok","ua":"curl/8","tainted":false},
				{"box":"box-2","at":1700000100,"error":"box_unreachable","last_seen":1700000100,"tainted":true}
			]`
			if q.Get("box") == "box-1" {
				rows = `[
					{"box":"box-1","at":1699999900,"actor":"owner","action":"tapped","device":"dev","ip":"127.0.0.1","result":"ok","ua":"curl/8","tainted":false}
				]`
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"rows":` + rows + `}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"unknown_box"}`))
		}
	})
}

// runFleet builds the fleet command against the stub, executes args, and
// returns combined output plus the execute error.
func runFleet(t *testing.T, srv *httptest.Server, stdin string, args ...string) (string, error) {
	t.Helper()
	t.Setenv("OCD_WORKER_URL", srv.URL)
	t.Setenv("OCD_FLEET_TOKEN", "test-token")
	cmd := fleet.NewCommand()
	var out strings.Builder
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	if stdin != "" {
		cmd.SetIn(strings.NewReader(stdin))
	}
	cmd.SetArgs(args)
	err := cmd.Execute()
	return out.String(), err
}

func TestFleetStatusRendersThreeStates(t *testing.T) {
	stub := newStubWorker(t)
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	out, err := runFleet(t, srv, "", "status")
	if err != nil {
		t.Fatalf("fleet status: %v (output %q)", err, out)
	}
	lines := strings.Split(out, "\n")
	stateOf := func(id string) string {
		for _, l := range lines {
			if strings.Contains(l, id) {
				return l
			}
		}
		return ""
	}
	if l := stateOf("box-1"); !strings.Contains(l, "box-1.example.com") || !strings.Contains(l, "ok") {
		t.Fatalf("want fresh box-1 line to show hostname and ok, got %q (full %q)", l, out)
	}
	if l := stateOf("box-2"); !strings.Contains(l, "tombstoned") {
		t.Fatalf("want box-2 line to show tombstoned, got %q (full %q)", l, out)
	}
	// Stale box renders offline with its last-synced age, never bare ok.
	l := stateOf("box-3")
	if !strings.Contains(l, "offline") {
		t.Fatalf("want stale box-3 line to show offline, got %q (full %q)", l, out)
	}
	if !strings.Contains(l, "1h ago") {
		t.Fatalf("want stale box-3 line to show last-synced age, got %q (full %q)", l, out)
	}
	if got := stub.hitsFor("GET /api/backends"); got != 1 {
		t.Fatalf("want 1 backends hit, got %d", got)
	}
}

// TestBoxState pins the pure state classifier: fresh ok, tombstoned,
// stale offline, tombstone-wins-over-stale precedence, and the exact
// 90s boundary (exceeds = offline).
func TestBoxState(t *testing.T) {
	if fleet.OfflineAfter != 90*time.Second {
		t.Fatalf("want OfflineAfter 90s (fleet heartbeat contract), got %v", fleet.OfflineAfter)
	}
	now := time.Now()
	fresh := fleet.Backend{ID: "b", LastSeen: now.Unix()}
	if got := fleet.BoxState(fresh, now); got != "ok" {
		t.Fatalf("fresh box: want ok, got %q", got)
	}
	tomb := fleet.Backend{ID: "b", Tombstoned: true, LastSeen: now.Unix()}
	if got := fleet.BoxState(tomb, now); got != "tombstoned" {
		t.Fatalf("tombstoned box: want tombstoned, got %q", got)
	}
	stale := fleet.Backend{ID: "b", LastSeen: now.Add(-time.Hour).Unix()}
	if got := fleet.BoxState(stale, now); got != "offline" {
		t.Fatalf("stale box: want offline, got %q", got)
	}
	// A tombstoned box that also went quiet stays tombstoned: the block
	// is the binding fact, staleness is secondary.
	tombStale := fleet.Backend{ID: "b", Tombstoned: true, LastSeen: now.Add(-time.Hour).Unix()}
	if got := fleet.BoxState(tombStale, now); got != "tombstoned" {
		t.Fatalf("stale tombstoned box: want tombstoned, got %q", got)
	}
	edge := fleet.Backend{ID: "b", LastSeen: now.Add(-90 * time.Second).Unix()}
	if got := fleet.BoxState(edge, now); got != "ok" {
		t.Fatalf("exactly-90s box: want ok (offline only exceeds), got %q", got)
	}
	past := fleet.Backend{ID: "b", LastSeen: now.Add(-91 * time.Second).Unix()}
	if got := fleet.BoxState(past, now); got != "offline" {
		t.Fatalf("91s box: want offline, got %q", got)
	}
}

func TestFleetLinkPrintsURL(t *testing.T) {
	stub := newStubWorker(t)
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	out, err := runFleet(t, srv, "", "link", "box-1")
	if err != nil {
		t.Fatalf("fleet link: %v (output %q)", err, out)
	}
	if !strings.Contains(out, "https://proxy.example/?t=tok-1") {
		t.Fatalf("want link URL in output, got %q", out)
	}
	if got := stub.hitsFor("POST /api/backends/box-1/link"); got != 1 {
		t.Fatalf("want 1 link hit, got %d", got)
	}
}

func TestFleetNukeHelpDocumentsScopes(t *testing.T) {
	stub := newStubWorker(t)
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	// Nuke fans out as two scoped calls (audit to count boxes, revoke to
	// revoke them): the help must name both so a 401 is actionable.
	t.Setenv("OCD_WORKER_URL", srv.URL)
	t.Setenv("OCD_FLEET_TOKEN", "test-token")
	root := fleet.NewCommand()
	found := false
	help := ""
	for _, c := range root.Commands() {
		if c.Name() == "nuke" {
			found = true
			help = c.Long + "\n" + c.UsageString()
		}
	}
	if !found {
		t.Fatalf("fleet tree has no nuke subcommand")
	}
	for _, want := range []string{`"audit"`, `"revoke"`} {
		if !strings.Contains(help, want) {
			t.Fatalf("want nuke help to document %s scope, got:\n%s", want, help)
		}
	}
}

func TestFleetNukeCountFetch401HintsAuditScope(t *testing.T) {
	// Token without audit scope: the count-fetch 401 must name audit,
	// never revoke (the revoke-all call never runs).
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
	}))
	defer srv.Close()

	out, err := runFleet(t, srv, "3\n", "nuke", "--yes")
	if err == nil {
		t.Fatalf("want error on count-fetch 401, got nil (output %q)", out)
	}
	if !strings.Contains(err.Error(), `"audit"`) {
		t.Fatalf("want count-fetch 401 to name \"audit\" scope, got err=%v output=%q", err, out)
	}
	if strings.Contains(err.Error(), `"revoke"`) {
		t.Fatalf("count-fetch 401 must not name \"revoke\" scope: %v", err)
	}
}

func TestFleetNukeRevokeAll401HintsRevokeScope(t *testing.T) {
	// Token with audit but without revoke: backends lists 3 boxes, the
	// revoke-all 401 must name revoke, never audit.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/backends":
			now := time.Now().Unix()
			_, _ = fmt.Fprintf(w, `[
				{"id":"box-1","hostname":"box-1.example.com","epoch":1,"last_seq":7,"last_ts":1000,"last_seen":%d,"enrolled":1,"tombstoned":false},
				{"id":"box-2","hostname":"box-2.example.com","epoch":3,"last_seq":9,"last_ts":2000,"last_seen":%d,"enrolled":1,"tombstoned":true},
				{"id":"box-3","hostname":"box-3.example.com","epoch":1,"last_seq":5,"last_ts":900,"last_seen":%d,"enrolled":1,"tombstoned":false}
			]`, now, now, now-3600)
		case r.Method == http.MethodPost && r.URL.Path == "/api/revoke-all":
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"unknown_box"}`))
		}
	}))
	defer srv.Close()

	out, err := runFleet(t, srv, "3\n", "nuke", "--yes")
	if err == nil {
		t.Fatalf("want error on revoke-all 401, got nil (output %q)", out)
	}
	if !strings.Contains(err.Error(), `"revoke"`) {
		t.Fatalf("want revoke-all 401 to name \"revoke\" scope, got err=%v output=%q", err, out)
	}
	if strings.Contains(err.Error(), `"audit"`) {
		t.Fatalf("revoke-all 401 must not name \"audit\" scope: %v", err)
	}
}

func TestFleetNukeWithoutYesRefuses(t *testing.T) {
	stub := newStubWorker(t)
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	// The stub lists 3 boxes, so the typed confirm would be "3" — but
	// without --yes the command must refuse before any revoke-all POST.
	out, err := runFleet(t, srv, "3\n", "nuke")
	if err == nil {
		t.Fatalf("want refusal without --yes, got nil (output %q)", out)
	}
	if got := stub.hitsFor("POST /api/revoke-all"); got != 0 {
		t.Fatalf("refused nuke must never POST revoke-all, got %d hits", got)
	}
}

func TestFleetNukeConfirmsBoxCount(t *testing.T) {
	stub := newStubWorker(t)
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	out, err := runFleet(t, srv, "3\n", "nuke", "--yes")
	if err != nil {
		t.Fatalf("fleet nuke --yes: %v (output %q)", err, out)
	}
	if got := stub.hitsFor("POST /api/revoke-all"); got != 1 {
		t.Fatalf("want 1 revoke-all hit, got %d", got)
	}
	for _, want := range []string{"box-1", "revoked", "box-2", "tombstoned"} {
		if !strings.Contains(out, want) {
			t.Fatalf("want nuke output to contain %q, got %q", want, out)
		}
	}

	// Wrong count aborts before the POST.
	stub2 := newStubWorker(t)
	srv2 := httptest.NewServer(stub2.handler())
	defer srv2.Close()
	t.Setenv("OCD_WORKER_URL", srv2.URL)
	t.Setenv("OCD_FLEET_TOKEN", "test-token")
	cmd := fleet.NewCommand()
	var out2 strings.Builder
	cmd.SetOut(&out2)
	cmd.SetErr(&out2)
	cmd.SetIn(strings.NewReader("99\n"))
	cmd.SetArgs([]string{"nuke", "--yes"})
	if err := cmd.Execute(); err == nil {
		t.Fatalf("want refusal on wrong box count, got nil (output %q)", out2.String())
	}
	if got := stub2.hitsFor("POST /api/revoke-all"); got != 0 {
		t.Fatalf("wrong-count nuke must never POST revoke-all, got %d hits", got)
	}
}

func TestFleetUnauthorizedSurfacesCleanly(t *testing.T) {
	stub := newStubWorker(t)
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	t.Setenv("OCD_WORKER_URL", srv.URL)
	t.Setenv("OCD_FLEET_TOKEN", "wrong-token")
	cmd := fleet.NewCommand()
	var out strings.Builder
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs([]string{"status"})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("want error on 401, got nil (output %q)", out.String())
	}
	if !strings.Contains(strings.ToLower(err.Error()+out.String()), "unauthorized") {
		t.Fatalf("want clean unauthorized error, got err=%v output=%q", err, out.String())
	}
	if strings.Contains(err.Error()+out.String(), "wrong-token") {
		t.Fatalf("token must never appear in errors or output: %v %q", err, out.String())
	}
}

func TestFleetRevokePostsConfirm(t *testing.T) {
	stub := newStubWorker(t)
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	out, err := runFleet(t, srv, "", "revoke", "box-1")
	if err != nil {
		t.Fatalf("fleet revoke: %v (output %q)", err, out)
	}
	if !strings.Contains(out, "revoked") {
		t.Fatalf("want revoke result in output, got %q", out)
	}
	stub.mu.Lock()
	body := stub.bodies["POST /api/backends/box-1/revoke"]
	stub.mu.Unlock()
	if !strings.Contains(body, `"confirm":true`) {
		t.Fatalf("want revoke body to carry confirm:true, got %q", body)
	}
}

func TestFleetAuditFiltersByBox(t *testing.T) {
	stub := newStubWorker(t)
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	out, err := runFleet(t, srv, "", "audit", "--box", "box-1")
	if err != nil {
		t.Fatalf("fleet audit: %v (output %q)", err, out)
	}
	if !strings.Contains(out, "box-1") || !strings.Contains(out, "tapped") {
		t.Fatalf("want audit rows in output, got %q", out)
	}
	if got := stub.hitsFor("GET /api/audit?box=box-1&n=50"); got != 1 {
		t.Fatalf("want 1 filtered audit hit, got %d (hits %v)", got, stub.hits)
	}
}

func TestFleetRequiresToken(t *testing.T) {
	stub := newStubWorker(t)
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	t.Setenv("OCD_WORKER_URL", srv.URL)
	t.Setenv("OCD_FLEET_TOKEN", "")
	cmd := fleet.NewCommand()
	var out strings.Builder
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs([]string{"status"})
	if err := cmd.Execute(); err == nil {
		t.Fatalf("want refusal without OCD_FLEET_TOKEN, got nil")
	}
	if got := stub.hitsFor("GET /api/backends"); got != 0 {
		t.Fatalf("missing token must never hit the API, got %d hits", got)
	}
}

// A 403 carrying a Cloudflare interstitial means the Worker's server-side
// call to the box never reached it: bot protection answered instead. The
// error must say so, not just "403".
func TestForbiddenChallengePageExplainsBotProtection(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte("<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>"))
	}))
	defer srv.Close()
	t.Setenv("OCD_WORKER_URL", srv.URL)
	t.Setenv("OCD_FLEET_TOKEN", "test-token")
	c, err := fleet.NewClientFromEnv()
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	_, err = c.Link(context.Background(), "home")
	if err == nil {
		t.Fatal("want error")
	}
	if !strings.Contains(err.Error(), "bot protection") {
		t.Fatalf("error must name the cause, got: %v", err)
	}
}
