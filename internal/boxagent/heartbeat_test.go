package boxagent_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/mfenderov/ocd/internal/boxagent"
	"github.com/mfenderov/ocd/internal/store"
)

// heartbeatRecorder is what the worker received: one entry per beat.
type heartbeatRecorder struct {
	method string
	auth   string
	ct     string
	bodies []map[string]any
}

// last is the body of the last beat the worker received.
func (r *heartbeatRecorder) last() map[string]any {
	return r.bodies[len(r.bodies)-1]
}

// heartbeatServer starts a worker that records what it received and
// answers with the given replies, one per beat. The last reply is
// repeated when the beats outnumber the replies.
func heartbeatServer(t *testing.T, rec *heartbeatRecorder, replies ...string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.method = r.Method
		rec.auth = r.Header.Get("Authorization")
		rec.ct = r.Header.Get("Content-Type")
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		rec.bodies = append(rec.bodies, body)
		reply := `{"enrolled":false}`
		if len(replies) > 0 {
			reply = replies[min(len(rec.bodies)-1, len(replies)-1)]
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(reply))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// heartbeatStore opens the store the beats are counted in.
func heartbeatStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// The beat says which box it is: the id, the bearer and the content
// type are what the worker reads it by.
func TestHeartbeatPostsTheBox(t *testing.T) {
	st := heartbeatStore(t)
	var rec heartbeatRecorder
	srv := heartbeatServer(t, &rec, `{"enrolled":false}`)

	enrolled, err := boxagent.SendOnce(t.Context(), st, srv.Client(), srv.URL, "box-123", "tok-abc", "", "v1.2.3")
	if err != nil {
		t.Fatalf("SendOnce: %v", err)
	}
	if enrolled {
		t.Fatalf("want enrolled=false, got true")
	}
	if rec.method != http.MethodPost {
		t.Fatalf("want POST, got %q", rec.method)
	}
	if rec.auth != "Bearer tok-abc" {
		t.Fatalf("want Authorization %q, got %q", "Bearer tok-abc", rec.auth)
	}
	if rec.ct != "application/json" {
		t.Fatalf("want Content-Type application/json, got %q", rec.ct)
	}
	if rec.last()["id"] != "box-123" {
		t.Fatalf("want id box-123, got %v", rec.last()["id"])
	}
}

// The beat counts itself: the sequence moves on, and it carries the
// password epoch the worker compares.
func TestHeartbeatPostsTheSeqAndEpoch(t *testing.T) {
	st := heartbeatStore(t)
	if got := st.BumpEpoch(t.Context()); got != 1 {
		t.Fatalf("want epoch 1 after bump, got %d", got)
	}
	var rec heartbeatRecorder
	srv := heartbeatServer(t, &rec, `{"enrolled":false}`)

	if _, err := boxagent.SendOnce(t.Context(), st, srv.Client(), srv.URL,
		"box-123", "tok-abc", "", "v1.2.3"); err != nil {
		t.Fatalf("SendOnce: %v", err)
	}
	if rec.last()["seq"] != float64(1) {
		t.Fatalf("want seq 1, got %v", rec.last()["seq"])
	}
	if rec.last()["epoch"] != float64(1) {
		t.Fatalf("want epoch 1, got %v", rec.last()["epoch"])
	}
}

// The beat says which build it is and when it was sent: the worker shows
// both to the operator.
func TestHeartbeatPostsTheVersionAndTheTime(t *testing.T) {
	st := heartbeatStore(t)
	var rec heartbeatRecorder
	srv := heartbeatServer(t, &rec, `{"enrolled":false}`)

	before := time.Now().Unix()
	if _, err := boxagent.SendOnce(t.Context(), st, srv.Client(), srv.URL,
		"box-123", "tok-abc", "", "v1.2.3"); err != nil {
		t.Fatalf("SendOnce: %v", err)
	}
	after := time.Now().Unix()
	if rec.last()["version"] != "v1.2.3" {
		t.Fatalf("want version v1.2.3, got %v", rec.last()["version"])
	}
	boxNow, ok := rec.last()["box_now"].(float64)
	if !ok || int64(boxNow) < before || int64(boxNow) > after {
		t.Fatalf("want box_now in [%d,%d], got %v", before, after, rec.last()["box_now"])
	}
}

// An enrolled box has no enroll token to send: the worker already knows
// it.
func TestHeartbeatOmitsTheEnrollTokenWhenEnrolled(t *testing.T) {
	st := heartbeatStore(t)
	var rec heartbeatRecorder
	srv := heartbeatServer(t, &rec, `{"enrolled":false}`)

	if _, err := boxagent.SendOnce(t.Context(), st, srv.Client(), srv.URL,
		"box-123", "tok-abc", "", "v1.2.3"); err != nil {
		t.Fatalf("SendOnce: %v", err)
	}
	if _, present := rec.last()["enroll_token"]; present {
		t.Fatalf("want no enroll_token when already enrolled, got %v", rec.last()["enroll_token"])
	}
}

func TestMissingBoxIDFailsLoudly(t *testing.T) {
	st, err := store.Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		_, _ = w.Write([]byte(`{"enrolled":true}`))
	}))
	defer srv.Close()

	if _, err := boxagent.SendOnce(t.Context(), st, srv.Client(), srv.URL, "", "tok", "", "v"); err == nil {
		t.Fatal("want error for empty boxID, got nil")
	}
	if hits != 0 {
		t.Fatalf("want zero HTTP calls, got %d", hits)
	}
	if got := st.NextHeartbeatSeq(t.Context()); got != 1 {
		t.Fatalf("failed send must not consume seq, want next 1, got %d", got)
	}
}

// The enroll token rides along until the worker says the box is
// enrolled: the worker needs it to bind the box.
func TestEnrollTokenSentUntilEnrolled(t *testing.T) {
	st := heartbeatStore(t)
	var rec heartbeatRecorder
	srv := heartbeatServer(t, &rec, `{"enrolled":false}`, `{"enrolled":true}`, `{"enrolled":true}`)

	enrolled, err := boxagent.SendOnce(t.Context(), st, srv.Client(), srv.URL, "box-1", "tok", "enroll-secret", "v9")
	if err != nil {
		t.Fatalf("call 1: %v", err)
	}
	assertBeat(t, "call 1", enrolled, rec.bodies[0], false, "enroll-secret", 1)

	enrolled, err = boxagent.SendOnce(t.Context(), st, srv.Client(), srv.URL, "box-1", "tok", "enroll-secret", "v9")
	if err != nil {
		t.Fatalf("call 2: %v", err)
	}
	assertBeat(t, "call 2", enrolled, rec.bodies[1], true, "enroll-secret", 2)

	enrolled, err = boxagent.SendOnce(t.Context(), st, srv.Client(), srv.URL, "box-1", "tok", "", "v9")
	if err != nil {
		t.Fatalf("call 3: %v", err)
	}
	assertBeat(t, "call 3", enrolled, rec.bodies[2], true, "", 3)
}

// assertBeat checks one beat: what the worker said, the enroll token it
// carried and the sequence it counted.
func assertBeat(t *testing.T, call string, enrolled bool, body map[string]any,
	wantEnrolled bool, wantToken string, wantSeq int) {
	t.Helper()
	if enrolled != wantEnrolled {
		t.Fatalf("%s: want enrolled=%v, got %v", call, wantEnrolled, enrolled)
	}
	gotToken, present := body["enroll_token"]
	if wantToken == "" {
		if present {
			t.Fatalf("%s: want no enroll_token, got %v", call, gotToken)
		}
	} else if gotToken != wantToken {
		t.Fatalf("%s: want enroll_token %q, got %v", call, wantToken, gotToken)
	}
	if body["seq"] != float64(wantSeq) {
		t.Fatalf("%s: want seq %d, got %v", call, wantSeq, body["seq"])
	}
}

func TestHeartbeatNon200IsError(t *testing.T) {
	st, err := store.Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	if _, err := boxagent.SendOnce(t.Context(), st, srv.Client(), srv.URL, "box-1", "tok", "", "v"); err == nil {
		t.Fatal("want error on 500, got nil")
	}
}

func TestSendOnceLeavesCallerClientUntouched(t *testing.T) {
	st, err := store.Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"enrolled":true}`))
	}))
	defer srv.Close()

	// NOTE: srv.Client() may return a shared instance, so build independent
	// clients on the server's transport.
	tr := srv.Client().Transport

	custom := &http.Client{Transport: tr}
	custom.Timeout = 42 * time.Second
	if _, err := boxagent.SendOnce(t.Context(), st, custom, srv.URL, "box-1", "tok", "", "v"); err != nil {
		t.Fatalf("SendOnce: %v", err)
	}
	if custom.Timeout != 42*time.Second {
		t.Fatalf("want caller Timeout still 42s, got %v", custom.Timeout)
	}

	zero := &http.Client{Transport: tr}
	if _, err := boxagent.SendOnce(t.Context(), st, zero, srv.URL, "box-1", "tok", "", "v"); err != nil {
		t.Fatalf("SendOnce: %v", err)
	}
	if zero.Timeout != 0 {
		t.Fatalf("want caller Timeout still 0, got %v", zero.Timeout)
	}
}

func TestHeartbeatURLAcceptsBareAndFullBase(t *testing.T) {
	st, err := store.Open(t.Context(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/heartbeat" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"enrolled":true}`))
	}))
	defer srv.Close()
	for _, base := range []string{srv.URL, srv.URL + "/", srv.URL + "/api/heartbeat"} {
		if _, err := boxagent.SendOnce(t.Context(), st, srv.Client(), base, "box-1", "tok", "", "v"); err != nil {
			t.Fatalf("base %q must reach /api/heartbeat, got %v", base, err)
		}
	}
}
