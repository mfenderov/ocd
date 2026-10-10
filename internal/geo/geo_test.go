package geo_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mfenderov/ocd/internal/geo"
)

func TestLookupCity(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"status":"success","city":"Berlin","countryCode":"DE"}`)
	}))
	defer srv.Close()
	geo.Endpoint = srv.URL + "/json/"
	if got := geo.Lookup("9.9.9.9"); got != "Berlin, DE" {
		t.Fatalf("want Berlin, DE got %q", got)
	}
	if got := geo.Lookup("9.9.9.9"); got != "Berlin, DE" {
		t.Fatalf("cached want Berlin, DE got %q", got)
	}
	if n := geo.Requests(); n != 1 {
		t.Fatalf("want 1 request (cache), got %d", n)
	}
}

func TestLookupSkipsLocal(t *testing.T) {
	if got := geo.Lookup("127.0.0.1"); got != "" {
		t.Fatalf("want empty for loopback, got %q", got)
	}
	if got := geo.Lookup("not-an-ip"); got != "" {
		t.Fatalf("want empty for junk, got %q", got)
	}
}
