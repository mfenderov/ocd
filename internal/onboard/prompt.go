package onboard

import (
	"bufio"
	"context"
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

// ResolveEnrollCode returns the one-time enroll code for this run. With a
// code already pasted in, it uses that. Otherwise it asks for the box
// name, prints the Telegram command to send, and waits for the code the
// bot replies with. The box name is all the terminal needs to know: the
// code carries the rest, and the Worker binds it to that name.
func ResolveEnrollCode(ctx context.Context, w io.Writer, pasted string) (boxID string, code string, err error) {
	if pasted = strings.TrimSpace(pasted); pasted != "" {
		return "", pasted, nil
	}
	if !IsTTY() {
		return "", "", fmt.Errorf("onboard: no code given — run `ocd` on a terminal")
	}
	boxID, err = AskBoxName()
	if err != nil {
		return "", "", err
	}
	_, _ = fmt.Fprintf(w, "\nSend this to your Telegram bot:\n\n  %s\n\n", TelegramCommand(boxID))
	_, _ = fmt.Fprintln(w, "Then paste the code it replies with:")
	reader := bufio.NewReader(Stdin)
	line, err := reader.ReadString('\n')
	if err != nil && strings.TrimSpace(line) == "" {
		return "", "", fmt.Errorf("onboard: no code pasted")
	}
	code = strings.TrimSpace(strings.Trim(strings.TrimSpace(line), "`\"'"))
	if code == "" {
		return "", "", fmt.Errorf("onboard: no code pasted")
	}
	return boxID, code, nil
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
