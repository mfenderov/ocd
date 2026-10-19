package onboard

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"
)

// IsTTY reports whether stdin is a terminal. The TUI runs only then;
// pipes and CI take the flags-driven plain path instead of hanging.
func IsTTY() bool {
	fi, err := os.Stdin.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

var (
	titleStyle = lipgloss.NewStyle().Bold(true)
	okStyle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("2"))
	dimStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
)

// FormValues collects wizard inputs. Pre-fill from flags; empty means ask.
// Empty EnrollCode keeps the Telegram approve-tap flow; a typed code
// (from /enrollcode) enrolls immediately with no approve tap.
type FormValues struct {
	BoxID      string
	WorkerURL  string
	PublicHost string
	EnrollCode string
	TunnelName string
	UIHost     string
	CFToken    string
}

// RunForm prompts for the three onboarding inputs, validating as it goes.
// Flag-provided values pre-fill their fields.
func RunForm(pre FormValues) (FormValues, error) {
	out := pre
	if out.WorkerURL == "" {
		out.WorkerURL = DefaultWorkerURL
	}
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewNote().
				Title("ocd onboard").
				Description("One box, one fleet. This mints secrets, writes ~/.ocd/env, enrolls, then waits for your Telegram approval."),
			huh.NewInput().
				Title("Box id").
				Description("Lowercase letters, digits, dashes (e.g. mac).").
				Value(&out.BoxID).
				Validate(ValidateBoxID),
			huh.NewInput().
				Title("Worker URL").
				Value(&out.WorkerURL).
				Validate(func(s string) error {
					if !strings.HasPrefix(s, "https://") {
						return fmt.Errorf("must start with https://")
					}
					return nil
				}),
			huh.NewInput().
				Title("Public hostname").
				Description("Tunnel hostname serving this box (pair links use it).").
				Value(&out.PublicHost).
				Validate(func(s string) error {
					if strings.TrimSpace(s) == "" || strings.ContainsAny(s, " /:") {
						return fmt.Errorf("bare hostname, e.g. oc-mac.buyallmemes.com")
					}
					return nil
				}),
			huh.NewInput().
				Title("Enroll code (optional)").
				Description("From /enrollcode in Telegram; empty waits for an approve tap instead.").
				Value(&out.EnrollCode),
			huh.NewInput().
				Title("Tunnel name").
				Description("Cloudflare tunnel for this box; created if missing, reused if present.").
				Value(&out.TunnelName),
			huh.NewInput().
				Title("UI hostname (optional)").
				Description("Second tunnel hostname for the web UI; empty skips it.").
				Value(&out.UIHost),
			huh.NewInput().
				Title("Cloudflare API token (optional)").
				Description("Only if cloudflared never logged in here; used once, never stored.").
				EchoMode(huh.EchoModePassword).
				Value(&out.CFToken),
		),
	)
	if err := form.Run(); err != nil {
		return FormValues{}, err
	}
	return out, nil
}

type statusMsg string
type doneMsg struct{ err error }

type spinnerModel struct {
	spinner spinner.Model
	status  string
	done    bool
	err     error
	cancel  context.CancelFunc
}

func (m spinnerModel) Init() tea.Cmd { return m.spinner.Tick }

func (m spinnerModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		if msg.String() == "ctrl+c" || msg.String() == "esc" {
			m.cancel()
			return m, tea.Quit
		}
	case statusMsg:
		m.status = string(msg)
	case doneMsg:
		m.done = true
		m.err = msg.err
		return m, tea.Quit
	}
	var cmd tea.Cmd
	m.spinner, cmd = m.spinner.Update(msg)
	return m, cmd
}

func (m spinnerModel) View() string {
	if m.done {
		return ""
	}
	return fmt.Sprintf("\n  %s %s\n\n%s\n", m.spinner.View(), m.status, dimStyle.Render("esc aborts"))
}

// RunSpinner executes DoOnboard with live status, blocking until approval,
// timeout, or abort. Returns the DoOnboard error, if any.
func RunSpinner(ctx context.Context, cfg Config) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	p := tea.NewProgram(spinnerModel{
		spinner: spinner.New(spinner.WithSpinner(spinner.Dot)),
		status:  "starting…",
		cancel:  cancel,
	})
	go func() {
		err := DoOnboard(ctx, cfg, func(s string) { p.Send(statusMsg(s)) })
		p.Send(doneMsg{err})
	}()
	final, err := p.Run()
	if err != nil {
		return err
	}
	if m, ok := final.(spinnerModel); ok && m.err != nil {
		return m.err
	}
	return nil
}

// RunPlain is the non-TTY path: same flow, line prints, flags only.
func RunPlain(ctx context.Context, w io.Writer, cfg Config) error {
	say := func(s string) { _, _ = fmt.Fprintln(w, "•", s) }
	if err := DoOnboard(ctx, cfg, say); err != nil {
		return err
	}
	_, _ = fmt.Fprintln(w, okStyle.Render("onboarded ✓"))
	return nil
}

// RenderResult prints the closing panel: what happened and what is next.
func RenderResult(w io.Writer, cfg Config) {
	_, _ = fmt.Fprintln(w, titleStyle.Render("Box "+cfg.BoxID+" is in the fleet."))
	if cfg.Tunnel != nil {
		_, _ = fmt.Fprintf(w, "Tunnel %s is configured (config.yml written).\n", cfg.Tunnel.Name)
		_, _ = fmt.Fprintf(w, "  cloudflared tunnel run %s\n", cfg.Tunnel.Name)
	} else {
		_, _ = fmt.Fprintln(w, "Next: point a tunnel at this box, then start the daemon:")
		_, _ = fmt.Fprintln(w, "  cloudflared tunnel run <name>   # ingress -> :49400")
	}
	_, _ = fmt.Fprintln(w, "  ocd serve                       # heartbeat + admin + pair")
}
