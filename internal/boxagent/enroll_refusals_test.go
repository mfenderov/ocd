package boxagent_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/mfenderov/ocd/internal/boxagent"
)

// enrollServer answers the enrolment the way the brain does, with the
// given status and body.
func enrollServer(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// A box without a hostname is refused: the brain cannot bind it.
func TestEnrollRefusesAnEmptyHostname(t *testing.T) {
	hit := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
	}))
	t.Cleanup(srv.Close)

	_, err := boxagent.EnrollBox(context.Background(), srv.Client(), srv.URL, "box-9", "", "tok", "", boxagent.EnrollOptions{})
	if err == nil {
		t.Fatal("want an error for an empty hostname")
	}
	if !strings.Contains(err.Error(), "hostname") {
		t.Fatalf("the error must name the hostname, got %v", err)
	}
	if hit {
		t.Fatal("must not hit the network on invalid input")
	}
}

// A box without a token is refused: the brain cannot bind it.
func TestEnrollRefusesAnEmptyToken(t *testing.T) {
	hit := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
	}))
	t.Cleanup(srv.Close)

	_, err := boxagent.EnrollBox(context.Background(), srv.Client(), srv.URL, "box-9", "h.example.com", "", "", boxagent.EnrollOptions{})
	if err == nil {
		t.Fatal("want an error for an empty token")
	}
	if !strings.Contains(err.Error(), "token") {
		t.Fatalf("the error must name the token, got %v", err)
	}
	if hit {
		t.Fatal("must not hit the network on invalid input")
	}
}

// A brain that refuses the enrolment must say so: the box waits, and
// the operator knows nothing happened.
func TestEnrollReportsARefusal(t *testing.T) {
	srv := enrollServer(t, http.StatusForbidden, `{"error":"not_allowed"}`)

	_, err := boxagent.EnrollBox(context.Background(), srv.Client(), srv.URL, "box-9", "h.example.com", "tok", "", boxagent.EnrollOptions{})
	if err == nil {
		t.Fatal("want an error when the worker refuses")
	}
	if !strings.Contains(err.Error(), "403") {
		t.Fatalf("the error must name the status, got %v", err)
	}
}

// A brain that answers without a status leaves the box in the dark: the
// enrolment must be reported as failed.
func TestEnrollReportsAMissingStatus(t *testing.T) {
	srv := enrollServer(t, http.StatusOK, `{"id":"box-9"}`)

	_, err := boxagent.EnrollBox(context.Background(), srv.Client(), srv.URL, "box-9", "h.example.com", "tok", "", boxagent.EnrollOptions{})
	if err == nil {
		t.Fatal("want an error when the worker omits the status")
	}
	if !strings.Contains(err.Error(), "omitted status") {
		t.Fatalf("the error must name the missing status, got %v", err)
	}
}

// A brain that answers with something else than JSON leaves the box in
// the dark too.
func TestEnrollReportsAnUnreadableAnswer(t *testing.T) {
	srv := enrollServer(t, http.StatusOK, `not json`)

	_, err := boxagent.EnrollBox(context.Background(), srv.Client(), srv.URL, "box-9", "h.example.com", "tok", "", boxagent.EnrollOptions{})
	if err == nil {
		t.Fatal("want an error when the answer cannot be read")
	}
	if !strings.Contains(err.Error(), "decode enroll") {
		t.Fatalf("the error must name the unreadable answer, got %v", err)
	}
}

// The owner-issued token travels as a bearer: it marks the pending row
// trusted.
func TestEnrollSendsTheBearerWhenItHasOne(t *testing.T) {
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"enrolled","trusted":true}`))
	}))
	t.Cleanup(srv.Close)

	out, err := boxagent.EnrollBox(context.Background(), srv.Client(), srv.URL, "box-9", "h.example.com", "tok", "", boxagent.EnrollOptions{Bearer: "owner-token"})
	if err != nil {
		t.Fatalf("EnrollBox: %v", err)
	}
	if !out.Trusted {
		t.Fatal("the brain must trust a row claimed with the owner token")
	}
	if auth != "Bearer owner-token" {
		t.Fatalf("the owner token must travel as a bearer, got %q", auth)
	}
}

// A request without a deadline of its own is bounded: the enrolment
// cannot hang forever.
func TestEnrollBoundsTheRequest(t *testing.T) {
	srv := enrollServer(t, http.StatusOK, `{"status":"enrolled"}`)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := boxagent.EnrollBox(ctx, srv.Client(), srv.URL, "box-9", "h.example.com", "tok", "", boxagent.EnrollOptions{})
	if err == nil {
		t.Fatal("a cancelled run must be reported")
	}
}

// The enrolment must not outlive the timeout it was given.
func TestEnrollKeepsTheDeadlineOfTheCaller(t *testing.T) {
	srv := enrollServer(t, http.StatusOK, `{"status":"enrolled"}`)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := boxagent.EnrollBox(ctx, srv.Client(), srv.URL, "box-9", "h.example.com", "tok", "", boxagent.EnrollOptions{}); err != nil {
		t.Fatalf("EnrollBox: %v", err)
	}
}
