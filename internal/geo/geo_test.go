package geo_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/mfenderov/ocd/internal/geo"
)

func TestLookupCity(t *testing.T) {
	var requests atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		fmt.Fprint(w, `{"status":"success","city":"Berlin","countryCode":"DE"}`)
	}))
	defer srv.Close()
	geo.Endpoint = srv.URL + "/json/"
	if got := geo.Lookup(t.Context(), "9.9.9.9"); got != "Berlin, DE" {
		t.Fatalf("want Berlin, DE got %q", got)
	}
	if got := geo.Lookup(t.Context(), "9.9.9.9"); got != "Berlin, DE" {
		t.Fatalf("cached want Berlin, DE got %q", got)
	}
	if n := requests.Load(); n != 1 {
		t.Fatalf("want 1 request (cache), got %d", n)
	}
}

func TestLookupSkipsLocal(t *testing.T) {
	if got := geo.Lookup(t.Context(), "127.0.0.1"); got != "" {
		t.Fatalf("want empty for loopback, got %q", got)
	}
	if got := geo.Lookup(t.Context(), "not-an-ip"); got != "" {
		t.Fatalf("want empty for junk, got %q", got)
	}
}
