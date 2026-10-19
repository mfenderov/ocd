package cli

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/mfenderov/ocd/internal/admin"
	"github.com/mfenderov/ocd/internal/fleet"
	"github.com/mfenderov/ocd/internal/mint"
	"github.com/mfenderov/ocd/internal/onboard"
	"github.com/mfenderov/ocd/internal/store"
)

func dbPath() string {
	if p := os.Getenv("OCD_DB"); p != "" {
		return p
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".ocd", "ocd.db")
}

func openStore() (*store.Store, error) {
	p := dbPath()
	_ = os.MkdirAll(filepath.Dir(p), 0o700)
	return store.Open(p)
}

func realExec() (string, error) {
	url := os.Getenv("OCD_PAIR_URL")
	if url == "" {
		url = "https://oc.buyallmemes.com"
	}
	out, err := exec.Command("opencode", "pair", "--url", url).Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func Root() *cobra.Command {
	root := &cobra.Command{
		Use:   "ocd",
		Short: "OpenCode link dispenser",
		// Explicit environment wins; ~/.ocd/env fills the rest so every
		// command works without sourcing shell files first.
		PersistentPreRun: func(cmd *cobra.Command, args []string) {
			onboard.ApplyEnvDefaults()
		},
		// Bare `ocd` is the whole product: it enrolls this machine, or
		// reports the current one. Subcommands cover the rest.
		RunE: func(cmd *cobra.Command, args []string) error {
			return runOnboard(cmd.OutOrStdout(), onboard.Options{})
		},
	}

	serve := &cobra.Command{
		Use:   "serve",
		Short: "Run daemon (Telegram polling + /pair HTTP)",
		RunE: func(cmd *cobra.Command, args []string) error {
			return RunServe(cmd.OutOrStdout())
		},
	}

	var device string
	mintCmd := &cobra.Command{
		Use:   "mint",
		Short: "Mint a pair link",
		RunE: func(cmd *cobra.Command, args []string) error {
			st, err := openStore()
			if err != nil {
				return err
			}
			defer st.Close()
			link, err := mint.Mint(st, realExec, device, "cli")
			if err != nil {
				return err
			}
			_, _ = fmt.Fprint(cmd.OutOrStdout(), link)
			return nil
		},
	}
	mintCmd.Flags().StringVar(&device, "device", "", "device name")
	_ = mintCmd.MarkFlagRequired("device")

	devices := &cobra.Command{
		Use:   "devices",
		Short: "Manage devices",
	}
	devList := &cobra.Command{
		Use:   "list",
		Short: "List devices",
		RunE: func(cmd *cobra.Command, args []string) error {
			st, err := openStore()
			if err != nil {
				return err
			}
			defer st.Close()
			for _, name := range st.ListDevices() {
				d, _ := st.GetDevice(name)
				_, _ = fmt.Fprintf(cmd.OutOrStdout(), "%s\t%s\texpires=%d\n", d.Name, d.Platform, d.ExpiresAt)
			}
			return nil
		},
	}
	devAdd := &cobra.Command{
		Use:   "add <name> <platform>",
		Args:  cobra.ExactArgs(2),
		Short: "Add a device",
		RunE: func(cmd *cobra.Command, args []string) error {
			st, err := openStore()
			if err != nil {
				return err
			}
			defer st.Close()
			return st.AddDevice(args[0], args[1])
		},
	}
	devices.AddCommand(devList, devAdd)

	status := &cobra.Command{
		Use:   "status",
		Short: "Show daemon status",
		RunE: func(cmd *cobra.Command, args []string) error {
			st, err := openStore()
			if err != nil {
				return err
			}
			defer st.Close()
			out, err := exec.Command("opencode", "service", "status").Output()
			_ = out
			_ = err
			_, _ = fmt.Fprint(cmd.OutOrStdout(), admin.Status(st, func(name string, args ...string) (string, error) {
				o, e := exec.Command(name, args...).Output()
				return string(o), e
			}))
			return nil
		},
	}

	var revokeYes bool
	revoke := &cobra.Command{
		Use:   "revoke",
		Short: "Rotate password, kill all sessions",
		RunE: func(cmd *cobra.Command, args []string) error {
			if !revokeYes {
				return fmt.Errorf("confirm with --yes (logs you out everywhere)")
			}
			st, err := openStore()
			if err != nil {
				return err
			}
			defer st.Close()
			return admin.Revoke(st, func(name string, args ...string) (string, error) {
				o, e := exec.Command(name, args...).Output()
				return string(o), e
			})
		},
	}
	revoke.Flags().BoolVar(&revokeYes, "yes", false, "confirm")

	root.AddCommand(serve, mintCmd, devices, status, revoke, fleet.NewCommand(), onboardCmd(), serviceCmd())
	return root
}
