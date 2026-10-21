package onboard

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"
)

// Stdin is where a pasted code is read from. Tests replace it.
var Stdin io.Reader = os.Stdin

// TelegramCommand is the bot command the user must send to obtain an
// enroll code for a box.
func TelegramCommand(boxID string) string {
	return "/enrollcode " + boxID
}

// EnrollCommand is the paste-ready command that enrolls a box with the
// code the bot issued: `ocd onboard <box> <code>`. The bot sends it and
// the prompt accepts it pasted, so both sides share one shape.
func EnrollCommand(boxID, code string) string {
	return "ocd onboard " + boxID + " " + code
}

// ResolveEnroll resolves the two things a run needs: the name of this box
// and the one-time enroll code. A name the caller already has is used as
// is; otherwise it is asked — it is the only question onboarding asks. A
// code the caller already has is used as is; otherwise the user pastes
// the one the bot issues.
func ResolveEnroll(w io.Writer, givenBox, givenCode string) (boxID, code string, err error) {
	boxID, err = resolveBoxID(givenBox)
	if err != nil {
		return "", "", err
	}
	code, err = resolveEnrollCode(w, boxID, givenCode)
	if err != nil {
		return "", "", err
	}
	return boxID, code, nil
}

// resolveBoxID is the name of this box: the caller's, or the one the
// terminal asks for.
func resolveBoxID(givenBox string) (string, error) {
	boxID := strings.TrimSpace(givenBox)
	if boxID == "" {
		return askBoxID()
	}
	if err := ValidateBoxID(boxID); err != nil {
		return "", err
	}
	return boxID, nil
}

// askBoxID asks the terminal for the name of this box. Without a
// terminal there is nobody to ask.
func askBoxID() (string, error) {
	if !IsTTY() {
		return "", fmt.Errorf("onboard: no box name — pass it as an argument: ocd onboard <name>")
	}
	return AskBoxName()
}

// resolveEnrollCode is the one-time enroll code: the caller's, or the
// one the operator pastes.
func resolveEnrollCode(w io.Writer, boxID, givenCode string) (string, error) {
	code := strings.TrimSpace(givenCode)
	if code != "" {
		return code, nil
	}
	return askEnrollCode(w, boxID)
}

// askEnrollCode asks the operator for the code the bot issued. Without
// a terminal there is nobody to paste it.
func askEnrollCode(w io.Writer, boxID string) (string, error) {
	if !IsTTY() {
		return "", fmt.Errorf("onboard: no enroll code — paste it, or pass it: ocd onboard <name> <code>")
	}
	return AskEnrollCode(w, boxID)
}

// AskEnrollCode prints the Telegram command that issues the enroll code
// for boxID and returns the code the user pastes back. The paste may be
// the bare code or the whole command the bot sends: the code is the
// last field either way.
func AskEnrollCode(w io.Writer, boxID string) (string, error) {
	_, _ = fmt.Fprintf(w, "\nSend this to your Telegram bot:\n\n  %s\n\n", TelegramCommand(boxID))
	_, _ = fmt.Fprintln(w, "Then paste what it replies with (the code, or the whole line):")
	reader := bufio.NewReader(Stdin)
	line, err := reader.ReadString('\n')
	if err != nil && strings.TrimSpace(line) == "" {
		return "", fmt.Errorf("onboard: no code pasted")
	}
	code := pastedCode(line)
	if code == "" {
		return "", fmt.Errorf("onboard: no code pasted")
	}
	return code, nil
}

// pastedCode takes the code out of a pasted line: the bare code, or the
// last field of the paste-ready command the bot sends. Quotes and
// backticks around the code are decoration.
func pastedCode(pasted string) string {
	fields := strings.Fields(pasted)
	if len(fields) == 0 {
		return ""
	}
	last := fields[len(fields)-1]
	return strings.Trim(strings.TrimSpace(last), "`\"'")
}

// AskBoxName asks for the name of this machine. It is the only question
// the terminal asks: everything else derives from the name.
func AskBoxName() (string, error) {
	name := ""
	form := newForm(
		newInput("Name this machine", "Lowercase letters, digits, dashes (e.g. mac).", &name, ValidateBoxID),
	)
	if err := form.Run(); err != nil {
		return "", err
	}
	return name, nil
}
