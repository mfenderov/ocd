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
	// BoxID is the name of this box when the caller already knows it.
	BoxID string
	// EnrollCode is the one-time enroll code when the caller already has it.
	EnrollCode     string
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
	// PairURL is the OpenCode UI origin the pairing link points at.
	PairURL string
	// Tunnel, when non-nil, provisions the Cloudflare tunnel + DNS after
	// the env file is written and before enrollment.
	Tunnel       *TunnelPlan
	EnvPath      string
	DBPath       string
	Timeout      time.Duration
	PollInterval time.Duration
}

// Result is what an onboarding did: the tunnel the box serves, what
// the daemon will run, and what bringing the box back up did.
type Result struct {
	// TunnelID is the tunnel the box serves: its id, the identity.
	// Empty when the box has no tunnel.
	TunnelID string
	// DaemonRunsTunnel says whether the daemon runs the connector
	// itself. The env file decides, and the env file is what the
	// daemon reads.
	DaemonRunsTunnel bool
	// Restart is what bringing the box back up did: what did not
	// happen, and who runs the daemon now.
	Restart RestartResult
}

// DefaultDBPath is the one rule for the database path: OCD_DB, else
// ~/.ocd/ocd.db. The CLI calls it too, so the error names the failure
// and not this package: the operator may be running `ocd serve`, not
// the onboarding.
func DefaultDBPath() (string, error) {
	if p := os.Getenv("OCD_DB"); p != "" {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("home dir: %w", err)
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
func DoOnboard(ctx context.Context, cfg Config, progress func(string)) (Result, error) {
	var res Result
	say := notifier(progress)
	if err := ValidateBoxID(cfg.BoxID); err != nil {
		return res, err
	}
	cfg = onboardDefaults(cfg)
	dbPath, err := onboardDBPath(cfg)
	if err != nil {
		return res, err
	}
	say("minting box secrets")
	heartbeatToken, adminToken, err := onboardSecrets(cfg)
	if err != nil {
		return res, err
	}
	envVals := onboardEnvValues(cfg, dbPath, heartbeatToken, adminToken)
	res.TunnelID, err = setupOnboardTunnel(ctx, cfg, envVals, say)
	if err != nil {
		return res, err
	}
	client := &http.Client{Timeout: 30 * time.Second}
	say("requesting enrollment")
	outcome, err := boxagent.EnrollBox(ctx, client, cfg.WorkerURL, cfg.BoxID, cfg.PublicHost, heartbeatToken, adminToken, boxagent.EnrollOptions{Quiet: cfg.Quiet, TunnelID: res.TunnelID})
	if err != nil {
		return res, err
	}
	if err := awaitEnrollment(ctx, cfg, dbPath, client, heartbeatToken, outcome, say); err != nil {
		return res, err
	}
	say("writing " + cfg.EnvPath)
	if err := writeEnv(cfg, envVals); err != nil {
		return res, err
	}
	// The box must run what was just written: the connector must load
	// the new ingress rules, and the daemon the new env file. Both are
	// the platform's own services to restart.
	res.DaemonRunsTunnel = daemonManagesTunnel(cfg.EnvPath)
	res.Restart = RestartBox(ctx, res.TunnelID, res.DaemonRunsTunnel)
	return res, nil
}

// notifier is the progress reporter: nil-safe, so a caller that does not
// want progress does not have to pass one.
func notifier(progress func(string)) func(string) {
	return func(s string) {
		if progress != nil {
			progress(s)
		}
	}
}

// onboardDefaults fills the blanks of the configuration.
func onboardDefaults(cfg Config) Config {
	if cfg.WorkerURL == "" {
		cfg.WorkerURL = DefaultWorkerURL
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 10 * time.Minute
	}
	if cfg.PollInterval <= 0 {
		cfg.PollInterval = 5 * time.Second
	}
	return cfg
}

// onboardDBPath is the database the box keeps: the one the caller named,
// else the default. The onboarding's own failures carry its prefix; the
// shared rule does not.
func onboardDBPath(cfg Config) (string, error) {
	if cfg.DBPath != "" {
		return cfg.DBPath, nil
	}
	path, err := DefaultDBPath()
	if err != nil {
		return "", fmt.Errorf("onboard: %w", err)
	}
	return path, nil
}

// onboardSecrets mints the box's secrets: the heartbeat token (the code
// the bot issued, when there is one) and the admin token.
func onboardSecrets(cfg Config) (string, string, error) {
	// The code the bot issued IS the box's heartbeat secret: the Worker
	// binds the box to the token presented at enrollment, so anything
	// else here would 401 on every heartbeat.
	heartbeatToken := strings.TrimSpace(cfg.EnrollCode)
	if heartbeatToken == "" {
		token, err := GenerateSecret()
		if err != nil {
			return "", "", err
		}
		heartbeatToken = token
	}
	adminToken, err := GenerateSecret()
	if err != nil {
		return "", "", err
	}
	return heartbeatToken, adminToken, nil
}

// onboardEnvValues are the values the box's env file must hold.
func onboardEnvValues(cfg Config, dbPath, heartbeatToken, adminToken string) map[string]string {
	return map[string]string{
		"OCD_BOX_ID": cfg.BoxID,
		// Absolute paths: this file is read by shells AND by systemd's
		// EnvironmentFile=, which does not expand $HOME.
		"OCD_DB":              dbPath,
		"OCD_WORKER_URL":      cfg.WorkerURL,
		"OCD_HEARTBEAT_TOKEN": heartbeatToken,
		"OCD_ENROLL_TOKEN":    heartbeatToken,
		"OCD_ADMIN_TOKEN":     adminToken,
		// PUBLIC_URL is the tap endpoint the worker hands out as a
		// one-time link, PAIR_URL is the OpenCode UI the pairing link
		// must point at — different hosts, different services.
		"OCD_PUBLIC_URL": tapBase(cfg.PublicHost) + "/pair",
		"OCD_PAIR_URL":   cfg.PairURL,
		// The tap endpoint is protected by the one-time token itself;
		// without this the browser gets 401 and no link ever works.
		"OCD_PAIR_OPEN": "1",
	}
}

// setupOnboardTunnel provisions the box's tunnel and names the tunnel
// the box serves.
func setupOnboardTunnel(ctx context.Context, cfg Config, envVals map[string]string, say func(string)) (string, error) {
	if cfg.Tunnel == nil {
		return "", nil
	}
	// The tunnel id tells the brain which cloudflared tunnel this box
	// uses, so the brain can own the box's DNS later. It stays empty
	// when the box has no tunnel.
	say("setting up tunnel " + cfg.Tunnel.Name)
	setup, err := SetupTunnel(ctx, *cfg.Tunnel, say)
	if err != nil {
		return "", err
	}
	if setup.Created {
		// This run created the tunnel: nothing else owns it, so
		// the daemon must run it. A run that reused the box's own
		// tunnel leaves that decision to whatever already
		// supervises it — and the env file keeps the key it had.
		envVals["OCD_MANAGE_TUNNEL"] = "1"
	}
	return setup.ID, nil
}

// awaitEnrollment waits for the owner's approval when the enrolment is
// pending, and says what the brain did about the DNS.
func awaitEnrollment(ctx context.Context, cfg Config, dbPath string, client *http.Client, heartbeatToken string, outcome boxagent.EnrollOutcome, say func(string)) error {
	if outcome.Status == "enrolled" {
		// The brain writes the box's DNS right after the enrolment
		// commits. When it could not, the owner is looking at this
		// terminal: say so, in the plan's words.
		sayEnrollment(say, outcome.DNS)
		return nil
	}
	if strings.TrimSpace(cfg.EnrollCode) != "" {
		return fmt.Errorf("onboard: code rejected (expired or already used) — request a fresh /enrollcode")
	}
	// One line, one wait: the owner is told once that the approval
	// is what the box is waiting for.
	say("waiting for Telegram approval…")
	st, err := store.Open(dbPath)
	if err != nil {
		return fmt.Errorf("onboard: open store: %w", err)
	}
	defer st.Close()
	waitCtx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()
	return WaitEnrolled(waitCtx, st, client, cfg.WorkerURL, cfg.BoxID, heartbeatToken, cfg.PollInterval)
}

// sayEnrollment says what the brain did about the box's DNS.
func sayEnrollment(say func(string), dns string) {
	if line := dnsOutcome(dns); line != "" {
		say(line)
		return
	}
	say("enrolled")
}

// daemonManagesTunnel says whether the daemon runs the connector: the
// env file decides, and the env file is what the daemon reads.
func daemonManagesTunnel(envPath string) bool {
	vals, err := LoadEnvFile(envPath)
	if err != nil {
		return false
	}
	return vals["OCD_MANAGE_TUNNEL"] == "1"
}

// writeEnv persists the box identity. It runs only after the enrollment
// bound, so a failed enroll never leaves the box heartbeating with a
// token the worker does not know (the "auth mismatch" clone warning).
func writeEnv(cfg Config, envVals map[string]string) error {
	return WriteEnvFile(cfg.EnvPath, envVals)
}

// dnsOutcome is the line the owner reads about the DNS the brain wrote
// (or did not). Empty when it did: the owner is at the terminal pasting
// the command, so this is where a failure belongs — and a success is
// not news.
//
// The brain's own status is carried as it stands ("failed: …",
// "skipped: …"), and the wording says what the status means: a failure
// is a breakage and only the owner can fix it, a skip is "there was
// nothing to do" — the brain wrote no DNS, and the owner is not the one
// needed.
func dnsOutcome(dns string) string {
	dns = strings.TrimSpace(dns)
	if dns == "" || dns == "ok" {
		return ""
	}
	if strings.HasPrefix(dns, "skipped:") {
		return "enrolled, but the brain wrote no DNS: " + dns
	}
	return "enrolled, but the DNS needs you: " + dns
}
