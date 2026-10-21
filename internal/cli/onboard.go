package cli

import (
	"context"
	"fmt"
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
			return runOnboard(cmd.OutOrStdout(), opts)
		},
	}
	cmd.Flags().StringVar(&workerURL, "worker-url", "", "fleet Worker origin (default "+onboard.DefaultWorkerURL+")")
	cmd.Flags().StringVar(&cfToken, "cf-token", "", "Cloudflare API token for tunnel+DNS (default: existing cloudflared login)")
	cmd.Flags().BoolVar(&skipTunnel, "skip-tunnel", false, "skip tunnel and DNS provisioning")
	cmd.Flags().BoolVar(&installService, "install-service", false, "install macOS login service")
	cmd.Flags().BoolVar(&force, "force", false, "re-onboard even if this machine already has an identity")
	return cmd
}

// runOnboard is the whole enrollment: one question, one Telegram round
// trip, then everything else automatic.
func runOnboard(w interface {
	Write([]byte) (int, error)
}, opts onboard.Options,
) error {
	ctx := context.Background()
	envPath, err := onboard.DefaultEnvPath()
	if err != nil {
		return err
	}
	if id, ok := onboard.ExistingIdentity(envPath); ok && !opts.Force {
		// Report what this box is before asking anything: on a box that
		// is already in the fleet, `ocd` is a status command.
		onboard.RenderIdentity(w, id)
		if !onboard.IsTTY() {
			return fmt.Errorf("already onboarded as %q — re-onboard with `ocd onboard --force`", id.BoxID)
		}
		again, err := onboard.AskReonboard(id.BoxID)
		if err != nil {
			return err
		}
		if !again {
			return nil
		}
	}
	boxID, code, err := onboard.ResolveEnroll(w, opts.BoxID, opts.EnrollCode)
	if err != nil {
		return err
	}
	host := onboard.TapHost(boxID)
	uiHost := onboard.UIHost(boxID)
	uiPort, note := onboard.OpenCodePortOrDefault(ctx)
	if note != "" {
		_, _ = fmt.Fprintf(w, "opencode: %s — assuming port %d\n", note, uiPort)
	}
	tunnel := &onboard.TunnelPlan{
		Name:     "oc-" + boxID,
		TapHost:  host,
		UIHost:   uiHost,
		APIToken: opts.CFToken,
		Port:     onboard.DaemonPort,
		UIPort:   uiPort,
	}
	if opts.SkipTunnel {
		tunnel = nil
	} else {
		credDir, err := onboard.DefaultCredDir()
		if err == nil {
			if err := onboard.EnsureCloudflaredLogin(ctx, credDir, opts.CFToken, onboard.IsTTY(), w); err != nil {
				return err
			}
		}
	}
	workerURL := opts.WorkerURL
	if workerURL == "" {
		workerURL = onboard.DefaultWorkerURL
	}
	cfg := onboard.Config{
		BoxID:      boxID,
		WorkerURL:  workerURL,
		PublicHost: host,
		PairURL:    "https://" + uiHost,
		EnrollCode: code,
		Quiet:      true,
		Tunnel:     tunnel,
		EnvPath:    envPath,
		Timeout:    10 * time.Minute,
	}
	var res onboard.Result
	if onboard.IsTTY() {
		res, err = onboard.RunSpinner(ctx, cfg)
	} else {
		res, err = onboard.RunPlain(ctx, w, cfg)
	}
	if err != nil {
		return err
	}
	serviced := false
	if opts.InstallService || onboard.IsTTY() {
		serviced, err = installService(w)
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
func installService(w interface {
	Write([]byte) (int, error)
},
) (bool, error) {
	if runtime.GOOS != "darwin" {
		_, _ = fmt.Fprintln(w, "service: automatic install supports macOS only — run ocd serve via your supervisor")
		return false, nil
	}
	path, err := onboard.InstallLoginService()
	if err != nil {
		return false, err
	}
	_, _ = fmt.Fprintln(w, "service installed: "+path)
	return true, nil
}
