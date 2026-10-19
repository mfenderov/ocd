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
		Use:   "onboard",
		Short: "Enroll this box in the fleet",
		// Runtime failures (bad code, refused config) report the error
		// without dumping the full usage text.
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runOnboard(cmd.OutOrStdout(), onboard.Options{
				WorkerURL:      workerURL,
				CFToken:        cfToken,
				SkipTunnel:     skipTunnel,
				InstallService: installService,
				Force:          force,
			})
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
	if existing, ok := onboard.ExistingBox(envPath); ok && !opts.Force {
		if !onboard.IsTTY() {
			return fmt.Errorf("already onboarded as %q — re-onboard interactively, or pass --force", existing)
		}
		again, err := onboard.AskReonboard(existing)
		if err != nil {
			return err
		}
		if !again {
			_, _ = fmt.Fprintf(w, "keeping existing setup for %s\n", existing)
			return nil
		}
	}
	boxID, code, err := onboard.ResolveEnrollCode(ctx, w, "")
	if err != nil {
		return err
	}
	host := onboard.TapHost(boxID)
	uiHost := onboard.UIHost(boxID)
	tunnel := &onboard.TunnelPlan{
		Name:     "oc-" + boxID,
		TapHost:  host,
		UIHost:   uiHost,
		APIToken: opts.CFToken,
		Port:     onboard.DaemonPort,
		UIPort:   onboard.OpenCodePort,
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
	if onboard.IsTTY() {
		err = onboard.RunSpinner(ctx, cfg)
	} else {
		err = onboard.RunPlain(ctx, w, cfg)
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
	onboard.RenderResult(w, cfg, serviced)
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
