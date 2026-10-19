package cli

import (
	"fmt"
	"runtime"

	"github.com/spf13/cobra"

	"github.com/mfenderov/ocd/internal/onboard"
)

// repairCmd fixes a box that an older build wired up wrongly: the tap
// URL, the pairing URL, and the tunnel's editor rule. It repairs what it
// can derive and touches nothing else.
func repairCmd() *cobra.Command {
	var boxID string
	var restart bool
	cmd := &cobra.Command{
		Use:   "repair",
		Short: "Fix this box's wiring (tap URL, pairing URL, tunnel rules)",
		RunE: func(cmd *cobra.Command, args []string) error {
			out := cmd.OutOrStdout()
			if boxID == "" {
				envPath, err := onboard.DefaultEnvPath()
				if err != nil {
					return err
				}
				vals, err := onboard.LoadEnvFile(envPath)
				if err != nil {
					return fmt.Errorf("repair: no env file yet (%s) — run `ocd` first", envPath)
				}
				boxID = vals["OCD_BOX_ID"]
			}
			if boxID == "" {
				return fmt.Errorf("repair: no box id — pass --box-id")
			}
			res, err := onboard.Repair(boxID)
			if err != nil {
				return err
			}
			if len(res.EnvChanged) == 0 && !res.TunnelFixed {
				_, _ = fmt.Fprintln(out, "✓ wiring already correct — nothing to repair")
			}
			for _, k := range res.EnvChanged {
				_, _ = fmt.Fprintf(out, "✓ env %s fixed\n", k)
			}
			if res.TunnelFixed {
				_, _ = fmt.Fprintln(out, "✓ tunnel config fixed (editor host → OpenCode)")
			}
			_, _ = fmt.Fprintln(out, onboard.EnvSummary(boxID))
			if runtime.GOOS == "darwin" && restart {
				path, err := onboard.InstallLoginService()
				if err != nil {
					return err
				}
				res.Restarted = true
				_, _ = fmt.Fprintln(out, "✓ service reloaded: "+path)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&boxID, "box-id", "", "box id (default: from OCD_BOX_ID)")
	cmd.Flags().BoolVar(&restart, "restart", true, "reload the login service after repairing")
	return cmd
}
