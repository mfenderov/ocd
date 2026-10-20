package admin

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"time"

	"github.com/mfenderov/ocd/internal/store"
)

// exec runs `opencode service ...`. Injected for tests.
type execFunc func(name string, args ...string) (string, error)

// ctxExec runs `opencode service ...` under the caller's deadline, so a
// hung command ends with the deadline instead of pinning the caller's
// goroutine forever. Injected for tests.
type ctxExec func(ctx context.Context, name string, args ...string) (string, error)

func newPassword() (string, error) {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}

// Revoke rotates the server password (signing out every session
// everywhere), restarts the service that `set` stops, and marks all
// known devices expired. Devices stay marked only after a verified start.
func Revoke(st *store.Store, exec execFunc) error {
	pw, err := newPassword()
	if err != nil {
		return err
	}
	if _, err := exec("opencode", "service", "set", "password", pw); err != nil {
		return fmt.Errorf("rotate password: %w", err)
	}
	if _, err := exec("opencode", "service", "start"); err != nil {
		return fmt.Errorf("restart service (password WAS rotated, sessions dead): %w", err)
	}
	if _, err := exec("opencode", "service", "status"); err != nil {
		return fmt.Errorf("service not responding after rotate (sessions dead): %w", err)
	}
	st.Audit("tg:owner", "revoked", "", "", "ok")
	for _, n := range st.ListDevices() {
		_ = st.ExpireDevice(n)
	}
	return nil
}

// Status is the service status line. The exec runs under ctx: the caller
// bounds it, so a hung opencode ends with the deadline instead of holding
// the caller's goroutine forever.
func Status(ctx context.Context, st *store.Store, exec ctxExec) string {
	addr, err := exec(ctx, "opencode", "service", "status")
	status := "service=" + firstLine(addr)
	if err != nil {
		status = "service=DOWN:" + err.Error()
	}
	remote, _ := exec(ctx, "opencode", "service", "get", "remote")
	return fmt.Sprintf("%s remote=%s devices=%d mints24h=%d\n",
		status, firstLine(remote), len(st.ListDevices()),
		st.CountRecentMints("", 24*time.Hour))
}

func StatusHTML(st *store.Store, exec execFunc) string {
	addr, err := exec("opencode", "service", "status")
	svc := firstLine(addr)
	if err != nil {
		svc = "DOWN: " + err.Error()
	}
	remote, _ := exec("opencode", "service", "get", "remote")
	return fmt.Sprintf("📊 <b>Status</b>\n• service <code>%s</code>\n• relay <code>%s</code>\n• devices <code>%d</code>\n• mints 24h <code>%d</code>",
		svc, firstLine(remote), len(st.ListDevices()),
		st.CountRecentMints("", 24*time.Hour))
}

func firstLine(s string) string {
	for i, c := range s {
		if c == '\n' {
			return s[:i]
		}
	}
	if s == "" {
		return "?"
	}
	return s
}
