package fleet

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

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
				_, _ = fmt.Fprintln(out, "no boxes enrolled")
				return nil
			}
			w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
			_, _ = fmt.Fprintln(w, "ID\tHOSTNAME\tEPOCH\tLAST_SEEN\tSTATE")
			now := time.Now()
			for _, b := range backs {
				state := BoxState(b, now)
				// Offline boxes carry their last-synced age inline so a
				// quiet box is never mistaken for a merely old row.
				if state == "offline" {
					state = "offline (synced " + syncAge(b.LastSeen, now.Unix()) + ")"
				}
				_, _ = fmt.Fprintf(w, "%s\t%s\t%d\t%d\t%s\n", b.ID, b.Hostname, b.Epoch, b.LastSeen, state)
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
			_, _ = fmt.Fprintln(cmd.OutOrStdout(), link)
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
		_, _ = fmt.Fprintf(&sb, " [box %d]", r.BoxStatus)
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
			_, _ = fmt.Fprintln(cmd.OutOrStdout(), formatResult(res))
			return nil
		},
	}
}

func nukeCmd() *cobra.Command {
	var yes bool
	nuke := &cobra.Command{
		Use:   "nuke",
		Short: "Revoke every box",
		Long: `Revoke every box in the fleet (two-step confirm: --yes plus typing the live box count).

Needs a CLI token with two scopes: "audit" to count boxes via
GET /api/backends for the typed-count confirm, and "revoke" to
POST /api/revoke-all. A 401 on either call names the missing scope.`,
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
				return nukeErr("count boxes", err, "audit")
			}
			want := strconv.Itoa(len(backs))
			_, _ = fmt.Fprintf(cmd.OutOrStdout(), "nuke will revoke %s box(es). Type %q to confirm: ", want, want)
			line, err := bufio.NewReader(cmd.InOrStdin()).ReadString('\n')
			if err != nil {
				return fmt.Errorf("fleet nuke: read confirm: %w", err)
			}
			if strings.TrimSpace(line) != want {
				return fmt.Errorf("fleet nuke: aborted (typed count does not match %s)", want)
			}
			results, err := client.RevokeAll(cmd.Context())
			if err != nil {
				return nukeErr("revoke all", err, "revoke")
			}
			for _, r := range results {
				_, _ = fmt.Fprintln(cmd.OutOrStdout(), formatResult(r))
			}
			return nil
		},
	}
	nuke.Flags().BoolVar(&yes, "yes", false, "confirm fleet-wide revoke")
	return nuke
}

// nukeErr annotates a nuke-stage failure with the CLI-token scope that
// stage needs, so a 401 names the missing scope (and the failed stage)
// instead of reading as a generic auth failure. Non-401 errors pass
// through unchanged; the token never appears (see APIError).
func nukeErr(stage string, err error, scope string) error {
	var apiErr *APIError
	if errors.As(err, &apiErr) && apiErr.Status == http.StatusUnauthorized {
		return fmt.Errorf("fleet nuke: %s: %w (token needs %q scope)", stage, err, scope)
	}
	return err
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
			return printAuditRows(cmd.OutOrStdout(), rows)
		},
	}
	audit.Flags().StringVar(&box, "box", "", "limit to one box id")
	audit.Flags().IntVar(&n, "n", 50, "max event rows (default 50, cap 200)")
	return audit
}

// printAuditRows renders the merged audit rows as a table.
func printAuditRows(out io.Writer, rows []AuditRow) error {
	if len(rows) == 0 {
		_, _ = fmt.Fprintln(out, "no audit rows")
		return nil
	}
	w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	_, _ = fmt.Fprintln(w, "BOX\tAT\tACTOR\tACTION\tRESULT\tFLAGS")
	for _, r := range rows {
		printAuditRow(w, r)
	}
	return w.Flush()
}

// printAuditRow renders one audit row: an event, or the marker of a box
// that could not be synced.
func printAuditRow(w io.Writer, r AuditRow) {
	flags := ""
	if r.Tainted {
		flags = "tainted"
	}
	if r.IsError() {
		_, _ = fmt.Fprintf(w, "%s\t%d\t-\t-\terror:%s\t%s\n", r.Box, r.At, auditErrorDetail(r), flags)
		return
	}
	_, _ = fmt.Fprintf(w, "%s\t%d\t%s\t%s\t%s\t%s\n", r.Box, r.At, r.Actor, r.Action, r.Result, flags)
}

// auditErrorDetail is the error of an audit row, with the detail the
// worker sent with it.
func auditErrorDetail(r AuditRow) string {
	if r.Detail == "" {
		return r.Error
	}
	return r.Error + ": " + r.Detail
}
