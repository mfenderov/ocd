// Package geo resolves a public IP to "City, CC" with an in-memory cache.
// Best effort: empty string on any failure. Never blocks callers long.
package geo

import (
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

func Lookup(ip string) string {
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

	city := fetch(ip)

	mu.Lock()
	cache[ip] = city
	mu.Unlock()
	return city
}

func fetch(ip string) string {
	mu.Lock()
	requests++
	mu.Unlock()
	resp, err := client.Get(Endpoint + ip + "?fields=status,city,countryCode")
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
