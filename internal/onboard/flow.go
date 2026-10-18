package onboard

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/mfenderov/ocd/internal/boxagent"
	"github.com/mfenderov/ocd/internal/store"
)

// Config gathers everything DoOnboard needs. EnvPath/DBPath are explicit so
// tests stay hermetic; the command fills them from ~/.ocd defaults.
type Config struct {
	BoxID        string
	WorkerURL    string
	PublicHost   string
	EnvPath      string
	DBPath       string
	Timeout      time.Duration
	PollInterval time.Duration
}

// DefaultDBPath mirrors internal/cli.openStore: OCD_DB or ~/.ocd/ocd.db.
func DefaultDBPath() (string, error) {
	if p := os.Getenv("OCD_DB"); p != "" {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("onboard: home dir: %w", err)
	}
	return filepath.Join(home, ".ocd", "ocd.db"), nil
}

// tapBase derives the public tap origin for one box.
func tapBase(host string) string {
	return "https://" + host
}

// DoOnboard runs the full enrollment: secrets, env file, enroll POST, then
// heartbeat until the owner approves in Telegram. Progress reports go to
// progress (nil-safe); the caller renders them (spinner or plain prints).
func DoOnboard(ctx context.Context, cfg Config, progress func(string)) error {
	say := func(s string) {
		if progress != nil {
			progress(s)
		}
	}
	if err := ValidateBoxID(cfg.BoxID); err != nil {
		return err
	}
	if cfg.WorkerURL == "" {
		cfg.WorkerURL = DefaultWorkerURL
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 10 * time.Minute
	}
	if cfg.PollInterval <= 0 {
		cfg.PollInterval = 5 * time.Second
	}
	say("minting box secrets")
	heartbeatToken, err := GenerateSecret()
	if err != nil {
		return err
	}
	adminToken, err := GenerateSecret()
	if err != nil {
		return err
	}
	say("writing " + cfg.EnvPath)
	err = WriteEnvFile(cfg.EnvPath, map[string]string{
		"OCD_BOX_ID":          cfg.BoxID,
		"OCD_WORKER_URL":      cfg.WorkerURL,
		"OCD_HEARTBEAT_TOKEN": heartbeatToken,
		"OCD_ENROLL_TOKEN":    heartbeatToken,
		"OCD_ADMIN_TOKEN":     adminToken,
		"OCD_PUBLIC_URL":      tapBase(cfg.PublicHost),
		"OCD_PAIR_URL":        tapBase(cfg.PublicHost),
	})
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 30 * time.Second}
	say("requesting enrollment (approve in Telegram)")
	status, err := boxagent.EnrollBox(ctx, client, cfg.WorkerURL, cfg.BoxID, cfg.PublicHost, heartbeatToken, adminToken)
	if err != nil {
		return err
	}
	if status == "enrolled" {
		say("already enrolled")
		return nil
	}
	dbPath := cfg.DBPath
	if dbPath == "" {
		dbPath, err = DefaultDBPath()
		if err != nil {
			return err
		}
	}
	st, err := store.Open(dbPath)
	if err != nil {
		return fmt.Errorf("onboard: open store: %w", err)
	}
	defer st.Close()
	say("waiting for Telegram approval…")
	waitCtx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()
	return WaitEnrolled(waitCtx, st, client, cfg.WorkerURL, cfg.BoxID, heartbeatToken, cfg.PollInterval)
}
