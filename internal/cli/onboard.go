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
	var boxID, workerURL, publicHost, enrollCode string
	var timeout time.Duration
	var nonInteractive bool
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
				})
				if err != nil {
					return err
				}
				boxID, workerURL, publicHost, enrollCode = vals.BoxID, vals.WorkerURL, vals.PublicHost, vals.EnrollCode
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
			cfg := onboard.Config{
				BoxID:      boxID,
				WorkerURL:  workerURL,
				PublicHost: publicHost,
				EnrollCode: enrollCode,
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
	cmd.Flags().DurationVar(&timeout, "timeout", 10*time.Minute, "approval wait timeout")
	cmd.Flags().BoolVar(&nonInteractive, "non-interactive", false, "skip the TUI even on a terminal")
	return cmd
}
