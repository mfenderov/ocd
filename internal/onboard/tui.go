package onboard

import (
	"context"
	"fmt"
	"io"
	"os"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"
	"github.com/mattn/go-isatty"
)

// IsTTY reports whether a terminal can prompt. The TUI runs only then;
// pipes and CI take the plain path instead of hanging. It reads the same
// source the code paste reads, so whoever replaces Stdin controls both.
// The huh forms read os.Stdin directly, so they are only reached when
// this says yes.
func IsTTY() bool {
	f, ok := Stdin.(*os.File)
	if !ok {
		return false
	}
	return isatty.IsTerminal(f.Fd())
}

var (
	titleStyle = lipgloss.NewStyle().Bold(true)
	okStyle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("2"))
	dimStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
)

// AskReonboard confirms wiping a previous onboarding. Default is No:
// re-running keeps the working box untouched.
func AskReonboard(box string) (bool, error) {
	again := false
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewConfirm().
				Title("Already onboarded as " + box).
				Description("Start a NEW onboarding? Fresh secrets, fresh enroll — the old identity stops working.").
				Affirmative("Yes, start over").
				Negative("No, keep it").
				Value(&again),
		),
	)
	if err := form.Run(); err != nil {
		return false, err
	}
	return again, nil
}

// AskInstallService confirms the macOS login service install. Non-TTY
// callers decide with --install-service instead.
func AskInstallService() (bool, error) {
	install := true
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewConfirm().
				Title("Install login service?").
				Description("Starts ocd serve automatically on login (launchd, macOS only).").
				Value(&install),
		),
	)
	if err := form.Run(); err != nil {
		return false, err
	}
	return install, nil
}

// newForm builds a single-group form. Every prompt in onboarding is one
// question, so the form is a thin wrapper over huh.
func newForm(fields ...huh.Field) *huh.Form {
	return huh.NewForm(huh.NewGroup(fields...))
}

// newInput builds a validated text input.
func newInput(title, description string, value *string, validate func(string) error) huh.Field {
	return huh.NewInput().
		Title(title).
		Description(description).
		Value(value).
		Validate(validate)
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
func RenderResult(w io.Writer, cfg Config, serviced bool) {
	_, _ = fmt.Fprintln(w, titleStyle.Render("Box "+cfg.BoxID+" is in the fleet."))
	if serviced {
		_, _ = fmt.Fprintln(w, "Login service installed: ocd serve starts automatically on login.")
		return
	}
	if cfg.Tunnel != nil {
		_, _ = fmt.Fprintf(w, "Tunnel %s is configured (config.yml written).\n", cfg.Tunnel.Name)
		_, _ = fmt.Fprintf(w, "  cloudflared tunnel run %s\n", cfg.Tunnel.Name)
	} else {
		_, _ = fmt.Fprintln(w, "Next: point a tunnel at this box, then start the daemon:")
		_, _ = fmt.Fprintln(w, "  cloudflared tunnel run <name>   # ingress -> :49400")
	}
	_, _ = fmt.Fprintln(w, "  ocd serve                       # heartbeat + admin + pair")
}

// RenderIdentity prints what this box is: its name and the URLs it
// serves. It is what `ocd` reports on a box that is already in the fleet.
func RenderIdentity(w io.Writer, id Identity) {
	_, _ = fmt.Fprintln(w, titleStyle.Render(id.BoxID+" is in the fleet."))
	if id.TapURL != "" {
		_, _ = fmt.Fprintf(w, "  tap:   %s\n", id.TapURL)
	}
	if id.UIURL != "" {
		_, _ = fmt.Fprintf(w, "  ui:    %s\n", id.UIURL)
	}
	if id.WorkerURL != "" {
		_, _ = fmt.Fprintf(w, "  fleet: %s\n", id.WorkerURL)
	}
	_, _ = fmt.Fprintln(w, "  reach it from Telegram: /link")
}
