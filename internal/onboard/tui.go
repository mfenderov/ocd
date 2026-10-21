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
type doneMsg struct {
	err error
	res Result
}

type spinnerModel struct {
	spinner spinner.Model
	status  string
	done    bool
	err     error
	res     Result
	cancel  context.CancelFunc
}

func (m spinnerModel) Init() tea.Cmd { return m.spinner.Tick }

func (m spinnerModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		return m.key(msg)
	case statusMsg:
		m.status = string(msg)
	case doneMsg:
		return m.finish(msg)
	}
	return m.spinnerUpdate(msg)
}

// key takes a key press: esc and ctrl+c abort the onboarding.
func (m spinnerModel) key(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if msg.String() != "ctrl+c" && msg.String() != "esc" {
		return m.spinnerUpdate(msg)
	}
	m.cancel()
	return m, tea.Quit
}

// finish takes the end of the onboarding.
func (m spinnerModel) finish(msg doneMsg) (tea.Model, tea.Cmd) {
	m.done = true
	m.err = msg.err
	m.res = msg.res
	return m, tea.Quit
}

// spinnerUpdate lets the spinner tick.
func (m spinnerModel) spinnerUpdate(msg tea.Msg) (tea.Model, tea.Cmd) {
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
func RunSpinner(ctx context.Context, cfg Config) (Result, error) {
	return runSpinner(ctx, cfg, nil)
}

// runSpinner is the spinner. The program options are a seam: a test
// drives the spinner without a terminal.
func runSpinner(ctx context.Context, cfg Config, opts []tea.ProgramOption) (Result, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	p := tea.NewProgram(spinnerModel{
		spinner: spinner.New(spinner.WithSpinner(spinner.Dot)),
		status:  "starting…",
		cancel:  cancel,
	}, opts...)
	go func() {
		res, err := DoOnboard(ctx, cfg, func(s string) { p.Send(statusMsg(s)) })
		p.Send(doneMsg{err: err, res: res})
	}()
	final, err := p.Run()
	if err != nil {
		return Result{}, err
	}
	m, ok := final.(spinnerModel)
	if !ok {
		return Result{}, nil
	}
	return m.res, m.err
}

// RunPlain is the non-TTY path: same flow, line prints, flags only.
func RunPlain(ctx context.Context, w io.Writer, cfg Config) (Result, error) {
	say := func(s string) { _, _ = fmt.Fprintln(w, "•", s) }
	res, err := DoOnboard(ctx, cfg, say)
	if err != nil {
		return res, err
	}
	_, _ = fmt.Fprintln(w, okStyle.Render("onboarded ✓"))
	return res, nil
}

// RenderResult prints the closing panel: what happened and what is next.
func RenderResult(w io.Writer, cfg Config, res Result, serviced bool) {
	_, _ = fmt.Fprintln(w, titleStyle.Render("Box "+cfg.BoxID+" is in the fleet."))
	if serviced {
		_, _ = fmt.Fprintln(w, "Login service installed: ocd serve starts automatically on login.")
		return
	}
	if cfg.Tunnel != nil {
		// The tunnel is named by its id: the name is a label, and a
		// rename must never be able to stop the box.
		_, _ = fmt.Fprintf(w, "Tunnel %s is configured (config.yml written).\n", res.TunnelID)
		if res.DaemonRunsTunnel {
			_, _ = fmt.Fprintln(w, "  the daemon runs the connector — it starts with the daemon")
		}
	} else {
		_, _ = fmt.Fprintln(w, "Next: point a tunnel at this box, then start the daemon:")
		_, _ = fmt.Fprintln(w, "  cloudflared tunnel run <name>   # ingress -> :49400")
	}
	// The daemon is only the operator's to start when no service runs
	// it: the onboarding restarts the platform's own service.
	if !res.Restart.DaemonRunsAsService {
		_, _ = fmt.Fprintln(w, "  ocd serve                       # heartbeat + admin + pair")
	}
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
