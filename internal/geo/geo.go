// Package geo resolves a public IP to "City, CC" with an in-memory cache.
// Best effort: empty string on any failure. Never blocks callers long.
package geo

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"sync"
	"time"
)

var (
	// Endpoint is a var for tests.
	Endpoint = "http://ip-api.com/json/"
	client   = &http.Client{Timeout: 4 * time.Second}

	mu       sync.Mutex
	cache    = map[string]string{}
	requests int
)

func Requests() int {
	mu.Lock()
	defer mu.Unlock()
	return requests
}

// Lookup resolves the city of a public IP. The caller's context bounds
// the lookup: a caller that goes away does not wait for the answer.
func Lookup(ctx context.Context, ip string) string {
	parsed := net.ParseIP(ip)
	if parsed == nil || !parsed.IsGlobalUnicast() || parsed.IsPrivate() {
		return ""
	}
	mu.Lock()
	if city, ok := cache[ip]; ok {
		mu.Unlock()
		return city
	}
	mu.Unlock()

	city := fetch(ctx, ip)

	mu.Lock()
	cache[ip] = city
	mu.Unlock()
	return city
}

func fetch(ctx context.Context, ip string) string {
	mu.Lock()
	requests++
	mu.Unlock()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, Endpoint+ip+"?fields=status,city,countryCode", nil)
	if err != nil {
		return ""
	}
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	var out struct {
		Status  string `json:"status"`
		City    string `json:"city"`
		Country string `json:"countryCode"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return ""
	}
	if out.Status != "success" || out.City == "" {
		return ""
	}
	if out.Country == "" {
		return out.City
	}
	return out.City + ", " + out.Country
}
