package cli

import (
	"context"
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

func openStore() (*store.Store, error) {
	// One rule for the database path: the onboarding has it, and it
	// fails loudly when the home directory cannot be read — a relative
	// path here once pointed the daemon at an empty database.
	p, err := onboard.DefaultDBPath()
	if err != nil {
		return nil, err
	}
	_ = os.MkdirAll(filepath.Dir(p), 0o700)
	return store.Open(p)
}

// realExec runs the real `opencode pair` to mint a link.
func realExec() (string, error) {
	out, err := exec.Command("opencode", "pair", "--url", pairURL()).Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// pairURL is the OpenCode origin the link points at.
func pairURL() string {
	if url := os.Getenv("OCD_PAIR_URL"); url != "" {
		return url
	}
	return "https://oc.buyallmemes.com"
}

// Root builds the ocd command tree.
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
			err := runOnboard(cmd.OutOrStdout(), onboard.Options{})
			if err != nil {
				// A runtime failure is not a usage problem: the bare
				// command has no usage worth dumping over its report.
				cmd.SilenceUsage = true
			}
			return err
		},
	}
	root.AddCommand(
		serveCmd(),
		mintCmd(),
		devicesCmd(),
		statusCmd(),
		revokeCmd(),
		fleet.NewCommand(),
		onboardCmd(),
		serviceCmd(),
		repairCmd(),
	)
	return root
}

// serveCmd runs the box daemon.
func serveCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "serve",
		Short: "Run the box daemon (/pair, box API, heartbeat, sweeps)",
		RunE: func(cmd *cobra.Command, args []string) error {
			return RunServe(cmd.OutOrStdout())
		},
	}
}

// mintCmd mints a pair link.
func mintCmd() *cobra.Command {
	var device string
	cmd := &cobra.Command{
		Use:   "mint",
		Short: "Mint a pair link",
		RunE: func(cmd *cobra.Command, args []string) error {
			link, err := mintLink(device)
			if err != nil {
				return err
			}
			_, _ = fmt.Fprint(cmd.OutOrStdout(), link)
			return nil
		},
	}
	cmd.Flags().StringVar(&device, "device", "", "device name")
	_ = cmd.MarkFlagRequired("device")
	return cmd
}

// mintLink mints a pair link for the named device.
func mintLink(device string) (string, error) {
	st, err := openStore()
	if err != nil {
		return "", err
	}
	defer st.Close()
	return mint.Mint(st, realExec, device, "cli")
}

// devicesCmd manages the devices the daemon serves.
func devicesCmd() *cobra.Command {
	devices := &cobra.Command{
		Use:   "devices",
		Short: "Manage devices",
	}
	devices.AddCommand(devicesListCmd(), devicesAddCmd())
	return devices
}

// devicesListCmd lists the devices the daemon serves.
func devicesListCmd() *cobra.Command {
	return &cobra.Command{
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
}

// devicesAddCmd adds a device the daemon serves.
func devicesAddCmd() *cobra.Command {
	return &cobra.Command{
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
}

// statusCmd shows the status of the daemon and of the service it talks
// to.
func statusCmd() *cobra.Command {
	return &cobra.Command{
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
			_, _ = fmt.Fprint(cmd.OutOrStdout(), admin.Status(cmd.Context(), st, func(ctx context.Context, name string, args ...string) (string, error) {
				o, e := exec.CommandContext(ctx, name, args...).Output()
				return string(o), e
			}))
			return nil
		},
	}
}

// revokeCmd rotates the password and kills every session.
func revokeCmd() *cobra.Command {
	var revokeYes bool
	cmd := &cobra.Command{
		Use:   "revoke",
		Short: "Rotate password, kill all sessions",
		RunE: func(cmd *cobra.Command, args []string) error {
			return revokeSessions(revokeYes)
		},
	}
	cmd.Flags().BoolVar(&revokeYes, "yes", false, "confirm")
	return cmd
}

// revokeSessions rotates the server password and kills every session.
// The operator has to confirm: it logs them out everywhere.
func revokeSessions(confirmed bool) error {
	if !confirmed {
		return fmt.Errorf("confirm with --yes (logs you out everywhere)")
	}
	return revokeAll()
}

// revokeAll rotates the server password and expires every device.
func revokeAll() error {
	st, err := openStore()
	if err != nil {
		return err
	}
	defer st.Close()
	return admin.Revoke(st, func(name string, args ...string) (string, error) {
		o, e := exec.Command(name, args...).Output()
		return string(o), e
	})
}
