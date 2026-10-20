package cli_test

import (
	"io"
	"os"
	"strings"
	"testing"

	"github.com/mfenderov/ocd/internal/cli"
	"github.com/mfenderov/ocd/internal/onboard"
)

// noTerminal makes the prompts refuse to run: these tests exercise the
// argument paths, which need no terminal.
func noTerminal(t *testing.T) {
	t.Helper()
	old := onboard.Stdin
	onboard.Stdin = strings.NewReader("")
	t.Cleanup(func() { onboard.Stdin = old })
}

// `ocd onboard mac` must not ask for the name again: it got one. It
// stops at the code, which cannot be pasted without a terminal.
func TestOnboardTakesTheBoxNameAsAnArgument(t *testing.T) {
	noTerminal(t)
	t.Setenv("HOME", t.TempDir())

	root := cli.Root()
	root.SetOut(io.Discard)
	root.SetErr(io.Discard)
	root.SetArgs([]string{"onboard", "mac"})
	err := root.Execute()
	if err == nil {
		t.Fatal("want an error: without a terminal the code cannot be pasted")
	}
	if !strings.Contains(err.Error(), "enroll code") {
		t.Fatalf("want the error to ask for the code, got %v", err)
	}
	if strings.Contains(err.Error(), "box name") {
		t.Fatalf("the name was given, it must not be asked again: %v", err)
	}
}

// Without a name and without a terminal, the run must say which input is
// missing instead of opening a form nobody can fill in.
func TestOnboardWithoutANameSaysWhatIsMissing(t *testing.T) {
	noTerminal(t)
	t.Setenv("HOME", t.TempDir())

	root := cli.Root()
	root.SetOut(io.Discard)
	root.SetErr(io.Discard)
	root.SetArgs([]string{"onboard"})
	err := root.Execute()
	if err == nil {
		t.Fatal("want an error without a terminal")
	}
	if !strings.Contains(err.Error(), "box name") {
		t.Fatalf("want the error to ask for the name, got %v", err)
	}
}

// The advice must name a command that accepts --force: the bare command
// has no flags.
func TestAlreadyOnboardedErrorNamesACommandWithForce(t *testing.T) {
	noTerminal(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(home+"/.ocd", 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(home+"/.ocd/env", []byte("OCD_BOX_ID=\"home\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	root := cli.Root()
	root.SetOut(io.Discard)
	root.SetErr(io.Discard)
	root.SetArgs([]string{"onboard"})
	err := root.Execute()
	if err == nil {
		t.Fatal("want an error: re-onboarding needs a terminal")
	}
	if !strings.Contains(err.Error(), "ocd onboard --force") {
		t.Fatalf("want the error to name a command that accepts --force, got %v", err)
	}
}

// A box that is already in the fleet is identified by name, and the URLs
// it serves come from the env file, not from the box name.
func TestBareOcdReportsTheIdentityOfAnOnboardedBox(t *testing.T) {
	noTerminal(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(home+"/.ocd", 0o700); err != nil {
		t.Fatal(err)
	}
	env := `OCD_BOX_ID="home"
OCD_PUBLIC_URL="https://oc-tap.buyallmemes.com/pair"
OCD_PAIR_URL="https://oc.buyallmemes.com"
`
	if err := os.WriteFile(home+"/.ocd/env", []byte(env), 0o600); err != nil {
		t.Fatal(err)
	}

	var sb strings.Builder
	root := cli.Root()
	root.SetOut(&sb)
	root.SetErr(io.Discard)
	root.SetArgs([]string{})
	err := root.Execute()
	if err == nil {
		t.Fatal("want an error: re-onboarding needs a terminal")
	}
	got := sb.String()
	for _, want := range []string{"home", "https://oc-tap.buyallmemes.com/pair", "https://oc.buyallmemes.com"} {
		if !strings.Contains(got, want) {
			t.Fatalf("want the identity to mention %q, got %q", want, got)
		}
	}
	// A runtime failure is not a usage problem: the bare command must not
	// bury the identity under a wall of subcommands.
	if strings.Contains(got, "Available Commands") {
		t.Fatalf("a runtime failure must not dump the usage, got %q", got)
	}
}
