package fleet

import (
	"bufio"
	"fmt"
	"strconv"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

// NewCommand builds the `ocd fleet` tree. The client is constructed inside
// each RunE from env so tests can point OCD_WORKER_URL at an httptest stub.
func NewCommand() *cobra.Command {
	fleetCmd := &cobra.Command{
		Use:   "fleet",
		Short: "Manage fleet boxes via the Worker API",
	}
	fleetCmd.AddCommand(statusCmd(), linkCmd(), revokeCmd(), nukeCmd(), auditCmd())
	return fleetCmd
}

func statusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "List fleet boxes",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := NewClientFromEnv()
			if err != nil {
				return err
			}
			backs, err := client.Backends(cmd.Context())
			if err != nil {
				return err
			}
			out := cmd.OutOrStdout()
			if len(backs) == 0 {
				fmt.Fprintln(out, "no boxes enrolled")
				return nil
			}
			w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
			fmt.Fprintln(w, "ID\tHOSTNAME\tEPOCH\tLAST_SEEN\tSTATE")
			for _, b := range backs {
				state := "ok"
				if b.Tombstoned {
					state = "tombstoned"
				}
				fmt.Fprintf(w, "%s\t%s\t%d\t%d\t%s\n", b.ID, b.Hostname, b.Epoch, b.LastSeen, state)
			}
			return w.Flush()
		},
	}
}

func linkCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "link <box>",
		Args:  cobra.ExactArgs(1),
		Short: "Mint a tap link for a box",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := NewClientFromEnv()
			if err != nil {
				return err
			}
			link, err := client.Link(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), link)
			return nil
		},
	}
}

// formatResult renders one per-box revoke outcome on a single line.
func formatResult(r RevokeResult) string {
	var sb strings.Builder
	sb.WriteString(r.ID + ": " + r.Status)
	if r.Epoch != 0 || r.Status == "revoked" || r.Status == "tombstoned" {
		sb.WriteString(" (epoch " + strconv.Itoa(r.Epoch) + ")")
	}
	if r.BoxStatus != 0 {
		sb.WriteString(fmt.Sprintf(" [box %d]", r.BoxStatus))
	}
	if r.Detail != "" {
		sb.WriteString(": " + r.Detail)
	}
	return sb.String()
}

func revokeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "revoke <box>",
		Args:  cobra.ExactArgs(1),
		Short: "Revoke a box (rotates its password)",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := NewClientFromEnv()
			if err != nil {
				return err
			}
			res, err := client.Revoke(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), formatResult(res))
			return nil
		},
	}
}

func nukeCmd() *cobra.Command {
	var yes bool
	nuke := &cobra.Command{
		Use:   "nuke",
		Short: "Revoke every box",
		RunE: func(cmd *cobra.Command, args []string) error {
			if !yes {
				return fmt.Errorf("fleet nuke: confirm with --yes (revokes every box)")
			}
			client, err := NewClientFromEnv()
			if err != nil {
				return err
			}
			backs, err := client.Backends(cmd.Context())
			if err != nil {
				return err
			}
			want := strconv.Itoa(len(backs))
			fmt.Fprintf(cmd.OutOrStdout(), "nuke will revoke %s box(es). Type %q to confirm: ", want, want)
			line, err := bufio.NewReader(cmd.InOrStdin()).ReadString('\n')
			if err != nil {
				return fmt.Errorf("fleet nuke: read confirm: %w", err)
			}
			if strings.TrimSpace(line) != want {
				return fmt.Errorf("fleet nuke: aborted (typed count does not match %s)", want)
			}
			results, err := client.RevokeAll(cmd.Context())
			if err != nil {
				return err
			}
			for _, r := range results {
				fmt.Fprintln(cmd.OutOrStdout(), formatResult(r))
			}
			return nil
		},
	}
	nuke.Flags().BoolVar(&yes, "yes", false, "confirm fleet-wide revoke")
	return nuke
}

func auditCmd() *cobra.Command {
	var box string
	var n int
	audit := &cobra.Command{
		Use:   "audit",
		Short: "Show merged fleet audit rows",
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := NewClientFromEnv()
			if err != nil {
				return err
			}
			rows, err := client.Audit(cmd.Context(), box, n)
			if err != nil {
				return err
			}
			out := cmd.OutOrStdout()
			if len(rows) == 0 {
				fmt.Fprintln(out, "no audit rows")
				return nil
			}
			w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
			fmt.Fprintln(w, "BOX\tAT\tACTOR\tACTION\tRESULT\tFLAGS")
			for _, r := range rows {
				flags := ""
				if r.Tainted {
					flags = "tainted"
				}
				if r.IsError() {
					detail := r.Error
					if r.Detail != "" {
						detail += ": " + r.Detail
					}
					fmt.Fprintf(w, "%s\t%d\t-\t-\terror:%s\t%s\n", r.Box, r.At, detail, flags)
					continue
				}
				fmt.Fprintf(w, "%s\t%d\t%s\t%s\t%s\t%s\n", r.Box, r.At, r.Actor, r.Action, r.Result, flags)
			}
			return w.Flush()
		},
	}
	audit.Flags().StringVar(&box, "box", "", "limit to one box id")
	audit.Flags().IntVar(&n, "n", 50, "max event rows (default 50, cap 200)")
	return audit
}
