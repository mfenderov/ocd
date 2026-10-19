package cli

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/mfenderov/ocd/internal/onboard"
)

// serviceCmd manages the macOS login service that starts `ocd serve`.
// It never re-enrolls the box: the identity in ~/.ocd/env is untouched.
func serviceCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "service",
		Short: "Manage the login service that runs ocd serve",
	}
	install := &cobra.Command{
		Use:   "install",
		Short: "Install (or refresh) the login service",
		RunE: func(cmd *cobra.Command, args []string) error {
			// A box with a tunnel config should have its tunnel
			// supervised by the daemon, not by a terminal.
			if err := ensureTunnelManaged(); err != nil {
				return err
			}
			path, err := onboard.InstallLoginService()
			if err != nil {
				return err
			}
			_, _ = fmt.Fprintln(cmd.OutOrStdout(), "service installed: "+path)
			return nil
		},
	}
	uninstall := &cobra.Command{
		Use:   "uninstall",
		Short: "Stop and remove the login service",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := onboard.UnloadLoginService(); err != nil {
				return err
			}
			_, _ = fmt.Fprintln(cmd.OutOrStdout(), "service removed")
			return nil
		},
	}
	status := &cobra.Command{
		Use:   "status",
		Short: "Show the login service state",
		RunE: func(cmd *cobra.Command, args []string) error {
			state, err := onboard.ServiceStatus()
			if err != nil {
				return err
			}
			_, _ = fmt.Fprintln(cmd.OutOrStdout(), "service: "+state)
			return nil
		},
	}
	cmd.AddCommand(install, uninstall, status)
	return cmd
}

// ensureTunnelManaged turns on daemon-managed tunnels when this box has a
// cloudflared config. Explicit env wins; the flag is only added when the
// box would otherwise run a tunnel nobody supervises.
func ensureTunnelManaged() error {
	credDir, err := onboard.DefaultCredDir()
	if err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(credDir, "config.yml")); err != nil {
		return nil
	}
	if os.Getenv("OCD_MANAGE_TUNNEL") == "1" {
		return nil
	}
	envPath, err := onboard.DefaultEnvPath()
	if err != nil {
		return err
	}
	vals, err := onboard.LoadEnvFile(envPath)
	if err != nil {
		return nil
	}
	if vals["OCD_MANAGE_TUNNEL"] == "1" {
		return nil
	}
	return onboard.WriteEnvFile(envPath, map[string]string{"OCD_MANAGE_TUNNEL": "1"})
}
