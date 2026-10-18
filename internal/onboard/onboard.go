// Package onboard implements `ocd onboard`: single-command box enrollment.
// Pure logic (validation, secrets, env file, enroll-wait) lives here without
// any terminal dependency so it is unit-testable; the huh TUI in tui.go is
// a thin interactive shell around the same functions with a non-TTY
// fallback to flags.
package onboard

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/mfenderov/ocd/internal/boxadmin"
	"github.com/mfenderov/ocd/internal/boxagent"
	"github.com/mfenderov/ocd/internal/store"
)

// DefaultWorkerURL is the fleet origin new boxes join unless told otherwise.
const DefaultWorkerURL = "https://ocd-fleet.fenderovlol.workers.dev"

// ValidateBoxID accepts worker-safe box ids: 1-32 chars, lowercase
// alphanumerics and dashes, never leading or trailing with a dash.
func ValidateBoxID(id string) error {
	if len(id) < 1 || len(id) > 32 {
		return fmt.Errorf("onboard: box id must be 1-32 chars, got %d", len(id))
	}
	for _, r := range id {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' {
			continue
		}
		return fmt.Errorf("onboard: box id %q allows only a-z 0-9 -", id)
	}
	if strings.HasPrefix(id, "-") || strings.HasSuffix(id, "-") {
		return fmt.Errorf("onboard: box id %q must not start or end with -", id)
	}
	return nil
}

// GenerateSecret mints one 32-byte random secret (base64, single line)
// for heartbeat/enroll or admin use. Never logged by callers.
func GenerateSecret() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("onboard: random secret: %w", err)
	}
	return base64.StdEncoding.EncodeToString(b[:]), nil
}

// DefaultEnvPath is ~/.ocd/env, the file serve and boot.sh source.
func DefaultEnvPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("onboard: home dir: %w", err)
	}
	return filepath.Join(home, ".ocd", "env"), nil
}

// WriteEnvFile merges vals into the env file at path, preserving comments,
// blank lines, and unknown keys byte-for-byte. Values are double-quoted;
// the file is created 0600 (parent 0700) when missing. Merging is never
// destructive, so reruns are safe without a force flag.
func WriteEnvFile(path string, vals map[string]string) error {
	var lines []string
	if raw, err := os.ReadFile(path); err == nil {
		lines = strings.Split(string(raw), "\n")
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("onboard: read env: %w", err)
	}
	pending := map[string]string{}
	for k, v := range vals {
		pending[k] = v
	}
	for i, line := range lines {
		trimmed := strings.TrimLeft(line, " \t")
		for k := range pending {
			if strings.HasPrefix(trimmed, k+"=") {
				lines[i] = k + "=" + strconv.Quote(vals[k])
				delete(pending, k)
				break
			}
		}
	}
	if len(lines) == 0 {
		lines = append(lines, "# OCD secrets. chmod 600. Sourced by scripts/boot.sh and serve.")
	}
	for _, k := range slices.Sorted(maps.Keys(pending)) {
		lines = append(lines, k+"="+strconv.Quote(vals[k]))
	}
	out := strings.Join(lines, "\n")
	if !strings.HasSuffix(out, "\n") {
		out += "\n"
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("onboard: mkdir: %w", err)
	}
	if err := os.WriteFile(path, []byte(out), 0o600); err != nil {
		return fmt.Errorf("onboard: write env: %w", err)
	}
	return nil
}

// WaitEnrolled heartbeats until the Worker replies enrolled:true (owner
// approved in Telegram) or ctx expires. Network and 4xx failures are
// retried: approval lands whenever the owner taps, not on our schedule.
func WaitEnrolled(ctx context.Context, st *store.Store, client *http.Client, workerURL, boxID, token string, poll time.Duration) error {
	tick := time.NewTicker(poll)
	defer tick.Stop()
	for {
		enrolled, err := boxagent.SendOnce(st, client, workerURL, boxID, token, "", boxadmin.Version)
		if err == nil && enrolled {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("onboard: approval timed out: %w", ctx.Err())
		case <-tick.C:
		}
	}
}
