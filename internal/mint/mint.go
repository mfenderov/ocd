package mint

import (
	"errors"
	"os"
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

// Mint runs the pairing exec and counts one delivered session against the
// device's budget. The session is the tap: this exec is the one that
// hands the owner their editor.
func Mint(st *store.Store, exec func() (string, error), device, via string) (string, error) {
	if err := checkBudget(st, device); err != nil {
		return "", err
	}
	link, err := pairLink(exec)
	if err != nil {
		return "", err
	}
	_ = st.TouchMint(device, via)
	_ = st.RefreshExpiry(device, 30*24*time.Hour)
	return link, nil
}

// Preflight proves that pairing works without spending a session slot.
// The session is the tap-time mint, so only that exec counts; a pre-flight
// that counted would halve the owner's logins. The budget is still
// checked, so a spent budget refuses the link instead of handing out one
// that cannot be used.
func Preflight(st *store.Store, exec func() (string, error), device string) (string, error) {
	if err := checkBudget(st, device); err != nil {
		return "", err
	}
	return pairLink(exec)
}

// checkBudget refuses a mint when the session budget is spent: 5 sessions
// an hour for the device, 20 a day across the fleet. The count is the
// sessions already delivered.
func checkBudget(st *store.Store, device string) error {
	if os.Getenv("OCD_NO_CAP") == "1" {
		return nil
	}
	if st.CountRecentMints(device, time.Hour) >= 5 {
		return ErrRateLimited
	}
	if st.CountRecentMints("", 24*time.Hour) >= 20 {
		return ErrRateLimited
	}
	return nil
}

// pairLink runs the pairing command and extracts the one-time link from
// its output.
func pairLink(exec func() (string, error)) (string, error) {
	raw, err := exec()
	if err != nil {
		return "", err
	}
	link := ParseLink(raw)
	if link == "" {
		return "", errors.New("no link in pair output")
	}
	return link, nil
}
