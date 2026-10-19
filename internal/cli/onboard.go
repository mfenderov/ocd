package cli

import (
	"context"
	"fmt"
	"time"

	"github.com/spf13/cobra"

	"github.com/mfenderov/ocd/internal/onboard"
)

// onboardCmd implements `ocd onboard`: interactive TUI box enrollment with
// a flags-driven plain path when stdin is not a terminal.
func onboardCmd() *cobra.Command {
	var boxID, workerURL, publicHost, enrollCode, tunnelName, uiHost, cfToken string
	var timeout time.Duration
	var nonInteractive, skipTunnel bool
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
			var tunnel *onboard.TunnelPlan
			if !skipTunnel {
				defName, defUI := onboard.TunnelDefaults(boxID, publicHost)
				if tunnelName == "" {
					tunnelName = defName
				}
				if uiHost == "" {
					uiHost = defUI
				}
				tunnel = &onboard.TunnelPlan{
					Name:     tunnelName,
					TapHost:  publicHost,
					UIHost:   uiHost,
					Port:     49400,
					APIToken: cfToken,
				}
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
			onboard.RenderResult(cmd.OutOrStdout(), cfg)
			return nil
		},
	}
	cmd.Flags().StringVar(&boxID, "box-id", "", "box id (a-z 0-9 -)")
	cmd.Flags().StringVar(&workerURL, "worker-url", "", "fleet Worker origin (default "+onboard.DefaultWorkerURL+")")
	cmd.Flags().StringVar(&publicHost, "public-host", "", "tunnel hostname serving this box")
	cmd.Flags().StringVar(&enrollCode, "enroll-code", "", "one-time code from /enrollcode (skips the approve tap)")
	cmd.Flags().StringVar(&tunnelName, "tunnel-name", "", "cloudflared tunnel name (default oc-<box-id>)")
	cmd.Flags().StringVar(&uiHost, "ui-host", "", "tunnel hostname for the web UI (default oc-<box-id>.<domain>)")
	cmd.Flags().StringVar(&cfToken, "cf-token", "", "Cloudflare API token for tunnel+DNS (else uses cloudflared login)")
	cmd.Flags().BoolVar(&skipTunnel, "skip-tunnel", false, "skip tunnel and DNS provisioning")
	cmd.Flags().DurationVar(&timeout, "timeout", 10*time.Minute, "approval wait timeout")
	cmd.Flags().BoolVar(&nonInteractive, "non-interactive", false, "skip the TUI even on a terminal")
	return cmd
}
