package boxagent_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/mfenderov/ocd/internal/boxagent"
)

func TestEnrollPostsIdentityAndReturnsStatus(t *testing.T) {
	var (
		hit    bool
		method string
		auth   string
		body   map[string]any
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		method = r.Method
		auth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		if r.URL.Path != "/api/enroll" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"pending","id":"box-9"}`))
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	outcome, err := boxagent.EnrollBox(ctx, srv.Client(), srv.URL, "box-9", "box-9.example.com", "enroll-secret", "admin-secret", boxagent.EnrollOptions{})
	if err != nil {
		t.Fatalf("EnrollBox: %v", err)
	}
	if outcome.Status != "pending" {
		t.Fatalf("want pending, got %q", outcome.Status)
	}
	if !hit || method != http.MethodPost {
		t.Fatalf("want one POST, hit=%v method=%q", hit, method)
	}
	if auth != "" {
		t.Fatalf("enroll carries the token in the body, want no Authorization header, got %q", auth)
	}
	for k, want := range map[string]string{"id": "box-9", "hostname": "box-9.example.com", "enroll_token": "enroll-secret", "admin_token": "admin-secret"} {
		if body[k] != want {
			t.Fatalf("want body[%s]=%q, got %v", k, want, body[k])
		}
	}
}

// The brain reports what it did about the box's DNS after the enrolment
// committed. The box must carry that out of the response: it is the only
// thing the owner sees at the terminal, and the brain's Telegram report
// does not reach the box.
func TestEnrollCarriesTheDNSOutcome(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"enrolled","id":"box-9","trusted":true,"dns":"failed: the brain has no DNS credential"}`))
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	outcome, err := boxagent.EnrollBox(ctx, srv.Client(), srv.URL, "box-9", "box-9.example.com", "enroll-secret", "admin-secret", boxagent.EnrollOptions{})
	if err != nil {
		t.Fatalf("EnrollBox: %v", err)
	}
	if outcome.Status != "enrolled" || !outcome.Trusted {
		t.Fatalf("want an enrolled, trusted outcome, got %+v", outcome)
	}
	if outcome.DNS != "failed: the brain has no DNS credential" {
		t.Fatalf("want the DNS outcome carried out of the response, got %q", outcome.DNS)
	}
}

// The enrolment tells the brain which cloudflared tunnel the box uses,
// so the brain can own the box's DNS later. A box without a tunnel must
// leave the key out entirely, not send an empty id.
func TestEnrollPostsTunnelID(t *testing.T) {
	for _, tc := range []struct {
		name     string
		tunnelID string
		want     string
		present  bool
	}{
		{name: "with a tunnel", tunnelID: "tun-123", want: "tun-123", present: true},
		{name: "without a tunnel", tunnelID: "", present: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var body map[string]any
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				raw, _ := io.ReadAll(r.Body)
				_ = json.Unmarshal(raw, &body)
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"status":"enrolled","id":"box-9"}`))
			}))
			defer srv.Close()

			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_, err := boxagent.EnrollBox(ctx, srv.Client(), srv.URL, "box-9", "box-9.example.com", "enroll-secret", "admin-secret", boxagent.EnrollOptions{TunnelID: tc.tunnelID})
			if err != nil {
				t.Fatalf("EnrollBox: %v", err)
			}
			got, ok := body["tunnel_id"]
			if ok != tc.present {
				t.Fatalf("tunnel_id present=%v, want %v (body %v)", ok, tc.present, body)
			}
			if tc.present && got != tc.want {
				t.Fatalf("want tunnel_id %q, got %v", tc.want, got)
			}
		})
	}
}

func TestEnrollRefusesEmptyIdentity(t *testing.T) {
	hit := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := boxagent.EnrollBox(ctx, srv.Client(), srv.URL, "", "h.example.com", "tok", "", boxagent.EnrollOptions{}); err == nil {
		t.Fatal("want error for empty box id")
	}
	if hit {
		t.Fatal("must not hit the network on invalid input")
	}
}

func TestEnrollToleratesHeartbeatSuffixedOrigin(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"pending","id":"box-9"}`))
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// Home's OCD_WORKER_URL ends in /api/heartbeat; enroll must still land
	// on /api/enroll (bot /enrollcode 404 regression, 2026-10-19).
	if _, err := boxagent.EnrollBox(ctx, srv.Client(), srv.URL+"/api/heartbeat", "box-9", "h.example.com", "tok", "", boxagent.EnrollOptions{}); err != nil {
		t.Fatalf("EnrollBox: %v", err)
	}
	if gotPath != "/api/enroll" {
		t.Fatalf("want /api/enroll, got %q", gotPath)
	}
}
