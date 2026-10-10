package mint

import (
	"errors"
	"time"

	"github.com/mfenderov/ocd/internal/store"
)

var ErrRateLimited = errors.New("rate limited")

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
	_ = st.TouchMint(device, via)
	_ = st.RefreshExpiry(device, 30*24*time.Hour)
	return link, nil
}
