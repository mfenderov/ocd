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

func TestHeartbeatPostsSeqAndEpoch(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if got := st.BumpEpoch(); got != 1 {
		t.Fatalf("want epoch 1 after bump, got %d", got)
	}

	var (
		method string
		auth   string
		ct     string
		body   map[string]any
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method = r.Method
		auth = r.Header.Get("Authorization")
		ct = r.Header.Get("Content-Type")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"enrolled":false}`))
	}))
	defer srv.Close()

	before := time.Now().Unix()
	enrolled, err := boxagent.SendOnce(st, srv.Client(), srv.URL, "box-123", "tok-abc", "", "v1.2.3")
	after := time.Now().Unix()
	if err != nil {
		t.Fatalf("SendOnce: %v", err)
	}
	if enrolled {
		t.Fatalf("want enrolled=false, got true")
	}
	if method != http.MethodPost {
		t.Fatalf("want POST, got %q", method)
	}
	if auth != "Bearer tok-abc" {
		t.Fatalf("want Authorization %q, got %q", "Bearer tok-abc", auth)
	}
	if ct != "application/json" {
		t.Fatalf("want Content-Type application/json, got %q", ct)
	}
	if body["id"] != "box-123" {
		t.Fatalf("want id box-123, got %v", body["id"])
	}
	if body["seq"] != float64(1) {
		t.Fatalf("want seq 1, got %v", body["seq"])
	}
	if body["epoch"] != float64(1) {
		t.Fatalf("want epoch 1, got %v", body["epoch"])
	}
	if body["version"] != "v1.2.3" {
		t.Fatalf("want version v1.2.3, got %v", body["version"])
	}
	boxNow, ok := body["box_now"].(float64)
	if !ok || int64(boxNow) < before || int64(boxNow) > after {
		t.Fatalf("want box_now in [%d,%d], got %v", before, after, body["box_now"])
	}
	if _, present := body["enroll_token"]; present {
		t.Fatalf("want no enroll_token when already enrolled, got %v", body["enroll_token"])
	}
}

func TestMissingBoxIDFailsLoudly(t *testing.T) {
	st, err := store.Open(":memory:")
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

	if _, err := boxagent.SendOnce(st, srv.Client(), srv.URL, "", "tok", "", "v"); err == nil {
		t.Fatal("want error for empty boxID, got nil")
	}
	if hits != 0 {
		t.Fatalf("want zero HTTP calls, got %d", hits)
	}
	if got := st.NextHeartbeatSeq(); got != 1 {
		t.Fatalf("failed send must not consume seq, want next 1, got %d", got)
	}
}

func TestEnrollTokenSentUntilEnrolled(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	replies := []string{`{"enrolled":false}`, `{"enrolled":true}`, `{"enrolled":true}`}
	var bodies []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		bodies = append(bodies, body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(replies[len(bodies)-1]))
	}))
	defer srv.Close()

	enrolled, err := boxagent.SendOnce(st, srv.Client(), srv.URL, "box-1", "tok", "enroll-secret", "v9")
	if err != nil {
		t.Fatalf("call 1: %v", err)
	}
	if enrolled {
		t.Fatal("call 1: want enrolled=false, got true")
	}
	if bodies[0]["enroll_token"] != "enroll-secret" {
		t.Fatalf("call 1: want enroll_token present, got %v", bodies[0]["enroll_token"])
	}
	if bodies[0]["seq"] != float64(1) {
		t.Fatalf("call 1: want seq 1, got %v", bodies[0]["seq"])
	}

	enrolled, err = boxagent.SendOnce(st, srv.Client(), srv.URL, "box-1", "tok", "enroll-secret", "v9")
	if err != nil {
		t.Fatalf("call 2: %v", err)
	}
	if !enrolled {
		t.Fatal("call 2: want enrolled=true, got false")
	}
	if bodies[1]["enroll_token"] != "enroll-secret" {
		t.Fatalf("call 2: want enroll_token present, got %v", bodies[1]["enroll_token"])
	}
	if bodies[1]["seq"] != float64(2) {
		t.Fatalf("call 2: want seq 2, got %v", bodies[1]["seq"])
	}

	enrolled, err = boxagent.SendOnce(st, srv.Client(), srv.URL, "box-1", "tok", "", "v9")
	if err != nil {
		t.Fatalf("call 3: %v", err)
	}
	if !enrolled {
		t.Fatal("call 3: want enrolled=true, got false")
	}
	if _, present := bodies[2]["enroll_token"]; present {
		t.Fatalf("call 3: want enroll_token omitted after enrollment, got %v", bodies[2]["enroll_token"])
	}
	if bodies[2]["seq"] != float64(3) {
		t.Fatalf("call 3: want seq 3, got %v", bodies[2]["seq"])
	}
}

func TestHeartbeatNon200IsError(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	if _, err := boxagent.SendOnce(st, srv.Client(), srv.URL, "box-1", "tok", "", "v"); err == nil {
		t.Fatal("want error on 500, got nil")
	}
}

func TestSendOnceLeavesCallerClientUntouched(t *testing.T) {
	st, err := store.Open(":memory:")
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
	if _, err := boxagent.SendOnce(st, custom, srv.URL, "box-1", "tok", "", "v"); err != nil {
		t.Fatalf("SendOnce: %v", err)
	}
	if custom.Timeout != 42*time.Second {
		t.Fatalf("want caller Timeout still 42s, got %v", custom.Timeout)
	}

	zero := &http.Client{Transport: tr}
	if _, err := boxagent.SendOnce(st, zero, srv.URL, "box-1", "tok", "", "v"); err != nil {
		t.Fatalf("SendOnce: %v", err)
	}
	if zero.Timeout != 0 {
		t.Fatalf("want caller Timeout still 0, got %v", zero.Timeout)
	}
}
