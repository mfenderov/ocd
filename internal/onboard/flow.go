package onboard

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mfenderov/ocd/internal/boxagent"
	"github.com/mfenderov/ocd/internal/store"
)

// Options are the non-interactive knobs of `ocd onboard`. Everything
// else is derived or asked for.
type Options struct {
	WorkerURL      string
	CFToken        string
	SkipTunnel     bool
	InstallService bool
	Force          bool
}

// Config gathers everything DoOnboard needs. EnvPath/DBPath are explicit so
// tests stay hermetic; the command fills them from ~/.ocd defaults.
// EnrollCode, when set, replaces the approve-tap flow with the typed code
// from /enrollcode (the pending row already binds it).
type Config struct {
	BoxID      string
	WorkerURL  string
	PublicHost string
	EnrollCode string
	// Quiet suppresses the Worker's approve/deny ping: the owner already
	// holds the token, so a second message would only confuse.
	Quiet bool
	// Tunnel, when non-nil, provisions the Cloudflare tunnel + DNS after
	// the env file is written and before enrollment.
	Tunnel       *TunnelPlan
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
	// The code the bot issued IS the box's heartbeat secret: the Worker
	// binds the box to the token presented at enrollment, so anything
	// else here would 401 on every heartbeat.
	var err error
	heartbeatToken := strings.TrimSpace(cfg.EnrollCode)
	if heartbeatToken == "" {
		heartbeatToken, err = GenerateSecret()
		if err != nil {
			return err
		}
	}
	adminToken, err := GenerateSecret()
	if err != nil {
		return err
	}
	say("writing " + cfg.EnvPath)
	envVals := map[string]string{
		"OCD_BOX_ID":          cfg.BoxID,
		"OCD_WORKER_URL":      cfg.WorkerURL,
		"OCD_HEARTBEAT_TOKEN": heartbeatToken,
		"OCD_ENROLL_TOKEN":    heartbeatToken,
		"OCD_ADMIN_TOKEN":     adminToken,
		"OCD_PUBLIC_URL":      tapBase(cfg.PublicHost),
		"OCD_PAIR_URL":        tapBase(cfg.PublicHost),
	}
	if cfg.Tunnel != nil {
		// Onboard-provisioned tunnel => onboard-supervised tunnel:
		// `ocd serve` manages cloudflared itself, no external service.
		envVals["OCD_MANAGE_TUNNEL"] = "1"
	}
	err = WriteEnvFile(cfg.EnvPath, envVals)
	if err != nil {
		return err
	}
	if cfg.Tunnel != nil {
		say("setting up tunnel " + cfg.Tunnel.Name)
		if _, err := SetupTunnel(ctx, *cfg.Tunnel, say); err != nil {
			return err
		}
	}
	client := &http.Client{Timeout: 30 * time.Second}
	say("requesting enrollment")
	status, err := boxagent.EnrollBox(ctx, client, cfg.WorkerURL, cfg.BoxID, cfg.PublicHost, heartbeatToken, adminToken, boxagent.EnrollOptions{Quiet: cfg.Quiet})
	if err != nil {
		return err
	}
	if status == "enrolled" {
		say("enrolled")
		return nil
	}
	if strings.TrimSpace(cfg.EnrollCode) != "" {
		return fmt.Errorf("onboard: code rejected (expired or already used) — request a fresh /enrollcode")
	}
	say("waiting for Telegram approval…")
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
