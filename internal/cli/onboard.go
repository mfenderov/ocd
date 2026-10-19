package cli

import (
	"context"
	"fmt"
	"runtime"
	"time"

	"github.com/spf13/cobra"

	"github.com/mfenderov/ocd/internal/onboard"
)

// onboardTunnel resolves the tunnel plan: skip flag wins, otherwise the
// name defaults to oc-<box> and the UI hostname derives from the tap
// domain. A nil plan means `ocd serve` stays tunnel-free.
func onboardTunnel(ctx context.Context, tunnelName, uiHost, cfToken, boxID, publicHost string, skip bool, w interface {
	Write([]byte) (int, error)
},
) (*onboard.TunnelPlan, error) {
	_ = ctx
	if skip {
		return nil, nil
	}
	defName, defUI := onboard.TunnelDefaults(boxID, publicHost)
	if tunnelName == "" {
		tunnelName = defName
	}
	if uiHost == "" {
		uiHost = defUI
	}
	if cfToken == "" {
		_, _ = fmt.Fprintln(w, "tunnel: using existing cloudflared login (or --cf-token)")
	}
	return &onboard.TunnelPlan{
		Name:     tunnelName,
		TapHost:  publicHost,
		UIHost:   uiHost,
		APIToken: cfToken,
		Port:     49400,
	}, nil
}

// onboardService installs the macOS login service when asked (TUI prompt
// or --install-service). Other platforms print manual guidance instead.
func onboardService(interactive, flag bool, w interface {
	Write([]byte) (int, error)
},
) (bool, error) {
	if runtime.GOOS != "darwin" {
		_, _ = fmt.Fprintln(w, "service: automatic install supports macOS only — run ocd serve via your supervisor")
		return false, nil
	}
	want := flag
	if interactive {
		var err error
		want, err = onboard.AskInstallService()
		if err != nil {
			return false, err
		}
	}
	if !want {
		return false, nil
	}
	path, err := onboard.InstallLoginService()
	if err != nil {
		return false, err
	}
	_, _ = fmt.Fprintln(w, "service installed: "+path)
	return true, nil
}

// onboardCmd implements `ocd onboard`: interactive TUI box enrollment with
// a flags-driven plain path when stdin is not a terminal.
func onboardCmd() *cobra.Command {
	var boxID, workerURL, publicHost, enrollCode, tunnelName, uiHost, cfToken string
	var timeout time.Duration
	var nonInteractive, skipTunnel, installService bool
	cmd := &cobra.Command{
		Use:   "onboard",
		Short: "Enroll this box in the fleet (interactive TUI)",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := context.Background()
			if onboard.IsTTY() && !nonInteractive {
				vals, err := onboard.RunForm(onboard.FormValues{
					BoxID:      boxID,
					WorkerURL:  workerURL,
					PublicHost: publicHost,
					EnrollCode: enrollCode,
					TunnelName: tunnelName,
					UIHost:     uiHost,
					CFToken:    cfToken,
				})
				if err != nil {
					return err
				}
				boxID, workerURL, publicHost, enrollCode = vals.BoxID, vals.WorkerURL, vals.PublicHost, vals.EnrollCode
				tunnelName, uiHost, cfToken = vals.TunnelName, vals.UIHost, vals.CFToken
			} else {
				if boxID == "" || publicHost == "" {
					return fmt.Errorf("non-interactive onboard needs --box-id and --public-host")
				}
			}
			if workerURL == "" {
				workerURL = onboard.DefaultWorkerURL
			}
			envPath, err := onboard.DefaultEnvPath()
			if err != nil {
				return err
			}
			tunnel, err := onboardTunnel(ctx, tunnelName, uiHost, cfToken, boxID, publicHost, skipTunnel, cmd.OutOrStdout())
			if err != nil {
				return err
			}
			cfg := onboard.Config{
				BoxID:      boxID,
				WorkerURL:  workerURL,
				PublicHost: publicHost,
				EnrollCode: enrollCode,
				Tunnel:     tunnel,
				EnvPath:    envPath,
				Timeout:    timeout,
			}
			if onboard.IsTTY() && !nonInteractive {
				if err := onboard.RunSpinner(ctx, cfg); err != nil {
					return err
				}
			} else if err := onboard.RunPlain(ctx, cmd.OutOrStdout(), cfg); err != nil {
				return err
			}
			serviced := false
			if onboard.IsTTY() && !nonInteractive {
				var err error
				serviced, err = onboardService(true, false, cmd.OutOrStdout())
				if err != nil {
					return err
				}
			} else if installService {
				var err error
				serviced, err = onboardService(false, true, cmd.OutOrStdout())
				if err != nil {
					return err
				}
			}
			onboard.RenderResult(cmd.OutOrStdout(), cfg, serviced)
			return nil
		},
	}
	cmd.Flags().StringVar(&boxID, "box-id", "", "box id (a-z 0-9 -)")
	cmd.Flags().StringVar(&workerURL, "worker-url", "", "fleet Worker origin (default "+onboard.DefaultWorkerURL+")")
	cmd.Flags().StringVar(&publicHost, "public-host", "", "tunnel hostname serving this box")
	cmd.Flags().StringVar(&enrollCode, "enroll-code", "", "one-time code from /enrollcode (skips the approve tap)")
	cmd.Flags().StringVar(&tunnelName, "tunnel-name", "", "tunnel name (default oc-<box-id>)")
	cmd.Flags().StringVar(&uiHost, "ui-host", "", "extra tunnel hostname for the web UI (default oc-<box-id>.<domain>)")
	cmd.Flags().StringVar(&cfToken, "cf-token", "", "Cloudflare API token for tunnel+DNS (default: existing cloudflared login)")
	cmd.Flags().BoolVar(&skipTunnel, "skip-tunnel", false, "skip tunnel and DNS provisioning")
	cmd.Flags().DurationVar(&timeout, "timeout", 10*time.Minute, "approval wait timeout")
	cmd.Flags().BoolVar(&nonInteractive, "non-interactive", false, "skip the TUI even on a terminal")
	cmd.Flags().BoolVar(&installService, "install-service", false, "install macOS login service (non-interactive only; TUI asks)")
	return cmd
}
