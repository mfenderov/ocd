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

// ResolveEnroll resolves the two things a run needs: the name of this box
// and the one-time enroll code. A name the caller already has is used as
// is; otherwise it is asked — it is the only question onboarding asks. A
// code the caller already has is used as is; otherwise the user pastes
// the one the bot issues.
func ResolveEnroll(w io.Writer, givenBox, givenCode string) (boxID, code string, err error) {
	boxID = strings.TrimSpace(givenBox)
	if boxID == "" {
		if !IsTTY() {
			return "", "", fmt.Errorf("onboard: no box name — pass it as an argument: ocd onboard <name>")
		}
		boxID, err = AskBoxName()
		if err != nil {
			return "", "", err
		}
	} else if err := ValidateBoxID(boxID); err != nil {
		return "", "", err
	}

	code = strings.TrimSpace(givenCode)
	if code == "" {
		if !IsTTY() {
			return "", "", fmt.Errorf("onboard: no enroll code — paste it, or pass it: ocd onboard <name> <code>")
		}
		code, err = AskEnrollCode(w, boxID)
		if err != nil {
			return "", "", err
		}
	}
	return boxID, code, nil
}

// AskEnrollCode prints the Telegram command that issues the enroll code
// for boxID and returns the code the user pastes back.
func AskEnrollCode(w io.Writer, boxID string) (string, error) {
	_, _ = fmt.Fprintf(w, "\nSend this to your Telegram bot:\n\n  %s\n\n", TelegramCommand(boxID))
	_, _ = fmt.Fprintln(w, "Then paste the code it replies with:")
	reader := bufio.NewReader(Stdin)
	line, err := reader.ReadString('\n')
	if err != nil && strings.TrimSpace(line) == "" {
		return "", fmt.Errorf("onboard: no code pasted")
	}
	code := strings.TrimSpace(strings.Trim(strings.TrimSpace(line), "`\"'"))
	if code == "" {
		return "", fmt.Errorf("onboard: no code pasted")
	}
	return code, nil
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
