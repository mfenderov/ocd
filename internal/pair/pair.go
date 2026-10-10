package pair

import (
	"fmt"
	"net/http"
	"os"

	"github.com/mfenderov/ocd/internal/mint"
	"github.com/mfenderov/ocd/internal/store"
)

func authorized(r *http.Request) bool {
	if os.Getenv("OCD_PAIR_OPEN") == "1" {
		return true
	}
	return r.Header.Get("Cf-Access-Jwt-Assertion") != ""
}

func Handler(st *store.Store, exec func() (string, error)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		device := r.URL.Query().Get("device")
		if device == "" {
			device = "oneshot"
		}
		link, err := mint.Mint(st, exec, device, "web")
		if err != nil {
			if err == mint.ErrRateLimited {
				http.Error(w, "wait a bit before next link", http.StatusTooManyRequests)
				return
			}
			http.Error(w, "mint failed", http.StatusBadGateway)
			return
		}
		http.Redirect(w, r, link, http.StatusFound)
		fmt.Fprint(w, link)
	})
}
