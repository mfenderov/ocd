package cli

import (
	"context"
	"fmt"
	"io"
	"runtime"
	"time"

	"github.com/spf13/cobra"

	"github.com/mfenderov/ocd/internal/onboard"
)

// onboardCmd implements `ocd onboard`: enroll this machine. It asks one
// question (the name), prints the Telegram command to run, and finishes
// once the bot's code is pasted back.
func onboardCmd() *cobra.Command {
	var workerURL, cfToken string
	var skipTunnel, installService, force bool
	cmd := &cobra.Command{
		Use:   "onboard <box> [code]",
		Short: "Enroll this box in the fleet",
		// The box name and the enroll code are the only arguments: they
		// are what the bot hands out, so they can be pasted as they are.
		Args: cobra.MaximumNArgs(2),
		// Runtime failures (bad code, refused config) report the error
		// without dumping the full usage text.
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			opts := onboard.Options{
				WorkerURL:      workerURL,
				CFToken:        cfToken,
				SkipTunnel:     skipTunnel,
				InstallService: installService,
				Force:          force,
			}
			if len(args) > 0 {
				opts.BoxID = args[0]
			}
			if len(args) > 1 {
				opts.EnrollCode = args[1]
			}
			return runOnboard(cmd.Context(), cmd.OutOrStdout(), opts)
		},
	}
	cmd.Flags().StringVar(&workerURL, "worker-url", "", "fleet Worker origin (default "+onboard.DefaultWorkerURL+")")
	cmd.Flags().StringVar(&cfToken, "cf-token", "",
		"Cloudflare API token for tunnel+DNS (default: existing cloudflared login)")
	cmd.Flags().BoolVar(&skipTunnel, "skip-tunnel", false, "skip tunnel and DNS provisioning")
	cmd.Flags().BoolVar(&installService, "install-service", false, "install macOS login service")
	cmd.Flags().BoolVar(&force, "force", false, "re-onboard even if this machine already has an identity")
	return cmd
}

// runOnboard is the whole enrollment: one question, one Telegram round
// trip, then everything else automatic.
func runOnboard(ctx context.Context, w io.Writer, opts onboard.Options) error {
	envPath, err := onboard.DefaultEnvPath()
	if err != nil {
		return err
	}
	again, err := confirmReonboard(w, envPath, opts)
	if err != nil {
		return err
	}
	if !again {
		return nil
	}
	boxID, code, err := onboard.ResolveEnroll(w, opts.BoxID, opts.EnrollCode)
	if err != nil {
		return err
	}
	cfg, err := onboardConfig(ctx, w, opts, envPath, boxID, code)
	if err != nil {
		return err
	}
	res, err := runEnrollment(ctx, w, cfg)
	if err != nil {
		return err
	}
	return reportOnboard(ctx, w, cfg, res, opts)
}

// confirmReonboard asks a box that is already in the fleet whether it
// may start over. It reports false when the run must not continue.
func confirmReonboard(w io.Writer, envPath string, opts onboard.Options) (bool, error) {
	id, ok := onboard.ExistingIdentity(envPath)
	if !ok || opts.Force {
		return true, nil
	}
	// Report what this box is before asking anything: on a box that
	// is already in the fleet, `ocd` is a status command.
	onboard.RenderIdentity(w, id)
	if !onboard.IsTTY() {
		return false, fmt.Errorf("already onboarded as %q — re-onboard with `ocd onboard --force`", id.BoxID)
	}
	again, err := onboard.AskReonboard(id.BoxID)
	if err != nil {
		return false, err
	}
	return again, nil
}

// onboardConfig is the configuration the enrollment runs with.
func onboardConfig(ctx context.Context, w io.Writer, opts onboard.Options,
	envPath, boxID, code string) (onboard.Config, error) {
	host := onboard.TapHost(boxID)
	uiHost := onboard.UIHost(boxID)
	uiPort, note := onboard.OpenCodePortOrDefault(ctx)
	if note != "" {
		_, _ = fmt.Fprintf(w, "opencode: %s — assuming port %d\n", note, uiPort)
	}
	tunnel, err := tunnelPlan(ctx, w, opts, boxID, host, uiHost, uiPort)
	if err != nil {
		return onboard.Config{}, err
	}
	workerURL := opts.WorkerURL
	if workerURL == "" {
		workerURL = onboard.DefaultWorkerURL
	}
	return onboard.Config{
		BoxID:      boxID,
		WorkerURL:  workerURL,
		PublicHost: host,
		PairURL:    "https://" + uiHost,
		EnrollCode: code,
		Quiet:      true,
		Tunnel:     tunnel,
		EnvPath:    envPath,
		Timeout:    10 * time.Minute,
	}, nil
}

// tunnelPlan is the tunnel the box will serve, and the login it needs
// before that tunnel can be created.
func tunnelPlan(ctx context.Context, w io.Writer, opts onboard.Options,
	boxID, host, uiHost string, uiPort int) (*onboard.TunnelPlan, error) {
	if opts.SkipTunnel {
		return nil, nil
	}
	tunnel := &onboard.TunnelPlan{
		Name:     "oc-" + boxID,
		TapHost:  host,
		UIHost:   uiHost,
		APIToken: opts.CFToken,
		Port:     onboard.DaemonPort,
		UIPort:   uiPort,
	}
	credDir, err := onboard.DefaultCredDir()
	if err != nil {
		// Without the credentials directory there is no login to ensure,
		// and a tunnel nobody can log in to is not a plan.
		return nil, err
	}
	if err := onboard.EnsureCloudflaredLogin(ctx, credDir, opts.CFToken, onboard.IsTTY(), w); err != nil {
		return nil, err
	}
	return tunnel, nil
}

// runEnrollment runs the enrollment: the spinner on a terminal, plain
// prints otherwise.
func runEnrollment(ctx context.Context, w io.Writer, cfg onboard.Config) (onboard.Result, error) {
	if onboard.IsTTY() {
		return onboard.RunSpinner(ctx, cfg)
	}
	return onboard.RunPlain(ctx, w, cfg)
}

// reportOnboard prints what the onboarding did, and what did not
// happen.
func reportOnboard(ctx context.Context, w io.Writer, cfg onboard.Config,
	res onboard.Result, opts onboard.Options) error {
	serviced := false
	if opts.InstallService || onboard.IsTTY() {
		var err error
		serviced, err = installService(ctx, w)
		if err != nil {
			return err
		}
	}
	onboard.RenderResult(w, cfg, res, serviced)
	// What did not happen is the operator's to fix, so it is said
	// loudly: the enrolment is committed, but the box still runs what
	// it ran before.
	for _, notice := range res.Restart.Notices {
		_, _ = fmt.Fprintln(w, "⚠ "+notice)
	}
	return nil
}

// installService installs the macOS login service. Other platforms print
// manual guidance instead.
func installService(ctx context.Context, w io.Writer) (bool, error) {
	if runtime.GOOS != "darwin" {
		_, _ = fmt.Fprintln(w, "service: automatic install supports macOS only — run ocd serve via your supervisor")
		return false, nil
	}
	return installLoginService(ctx, w)
}

// installLoginService installs the login service and says where it went.
func installLoginService(ctx context.Context, w io.Writer) (bool, error) {
	path, err := onboard.InstallLoginService(ctx)
	if err != nil {
		return false, err
	}
	_, _ = fmt.Fprintln(w, "service installed: "+path)
	return true, nil
}
