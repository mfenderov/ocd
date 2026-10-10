package cli

import (
	"fmt"
	"io"
)

func RunServe(w io.Writer) error {
	fmt.Fprintln(w, "serve needs Telegram token (Task 4) — set OCD_TG_TOKEN and OCD_OWNER_ID")
	return nil
}
