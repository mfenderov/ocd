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
	cmd.AddCommand(serviceInstallCmd(), serviceUninstallCmd(), serviceStatusCmd())
	return cmd
}

// serviceInstallCmd installs (or refreshes) the login service.
func serviceInstallCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "install",
		Short: "Install (or refresh) the login service",
		RunE: func(cmd *cobra.Command, args []string) error {
			// A box with a tunnel config should have its tunnel
			// supervised by the daemon, not by a terminal.
			if err := ensureTunnelManaged(); err != nil {
				return err
			}
			_, err := installLoginService(cmd.Context(), cmd.OutOrStdout())
			return err
		},
	}
}

// serviceUninstallCmd stops and removes the login service.
func serviceUninstallCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "uninstall",
		Short: "Stop and remove the login service",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := onboard.UnloadLoginService(cmd.Context()); err != nil {
				return err
			}
			_, _ = fmt.Fprintln(cmd.OutOrStdout(), "service removed")
			return nil
		},
	}
}

// serviceStatusCmd shows the state of the login service.
func serviceStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show the login service state",
		RunE: func(cmd *cobra.Command, args []string) error {
			state, err := onboard.ServiceStatus(cmd.Context())
			if err != nil {
				return err
			}
			_, _ = fmt.Fprintln(cmd.OutOrStdout(), "service: "+state)
			return nil
		},
	}
}

// ensureTunnelManaged turns on daemon-managed tunnels when this box has a
// cloudflared config. Explicit env wins; the flag is only added when the
// box would otherwise run a tunnel nobody supervises.
func ensureTunnelManaged() error {
	hasConfig, err := boxHasTunnelConfig()
	if err != nil {
		return err
	}
	if !hasConfig {
		return nil
	}
	if os.Getenv("OCD_MANAGE_TUNNEL") == "1" {
		return nil
	}
	return writeManageTunnel()
}

// boxHasTunnelConfig says whether this box has a cloudflared config.
func boxHasTunnelConfig() (bool, error) {
	credDir, err := onboard.DefaultCredDir()
	if err != nil {
		return false, err
	}
	_, err = os.Stat(filepath.Join(credDir, "config.yml"))
	return err == nil, nil
}

// writeManageTunnel turns on the daemon-managed tunnel in the env file,
// unless the env file already says so.
func writeManageTunnel() error {
	envPath, err := onboard.DefaultEnvPath()
	if err != nil {
		return err
	}
	vals, ok := envValues(envPath)
	if !ok {
		return nil
	}
	if vals["OCD_MANAGE_TUNNEL"] == "1" {
		return nil
	}
	return onboard.WriteEnvFile(envPath, map[string]string{"OCD_MANAGE_TUNNEL": "1"})
}

// envValues reads the env file, and reports whether it could be read.
func envValues(envPath string) (map[string]string, bool) {
	vals, err := onboard.LoadEnvFile(envPath)
	if err != nil {
		return nil, false
	}
	return vals, true
}
