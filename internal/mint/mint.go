package mint

import (
	"errors"
	"regexp"
	"time"

	"github.com/mfenderov/ocd/internal/store"
)

var ErrRateLimited = errors.New("rate limited")

var urlRe = regexp.MustCompile(`https://\S+`)

// ParseLink extracts the first https URL from raw `opencode pair` output,
// dropping the human text and ASCII QR block.
func ParseLink(raw string) string {
	return urlRe.FindString(raw)
}

func Mint(st *store.Store, exec func() (string, error), device, via string) (string, error) {
	if st.CountRecentMints(device, time.Hour) >= 5 {
		return "", ErrRateLimited
	}
	if st.CountRecentMints("", 24*time.Hour) >= 20 {
		return "", ErrRateLimited
	}
	link, err := exec()
	if err != nil {
		return "", err
	}
	link = ParseLink(link)
	if link == "" {
		return "", errors.New("no link in pair output")
	}
	_ = st.TouchMint(device, via)
	_ = st.RefreshExpiry(device, 30*24*time.Hour)
	return link, nil
}
