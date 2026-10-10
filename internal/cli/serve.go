package cli

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"

	"github.com/mfenderov/ocd/internal/pair"
	"github.com/mfenderov/ocd/internal/tg"
)

func RunServe(w io.Writer) error {
	st, err := openStore()
	if err != nil {
		return err
	}
	defer st.Close()

	execPair := func() (string, error) {
		url := os.Getenv("OCD_PAIR_URL")
		if url == "" {
			url = "https://oc.buyallmemes.com"
		}
		out, err := exec.Command("opencode", "pair", "--url", url).Output()
		return string(out), err
	}

	ctx := context.Background()
	go func() {
		if err := tg.Start(ctx, st); err != nil {
			fmt.Fprintln(w, "telegram:", err)
		}
	}()

	mux := http.NewServeMux()
	mux.Handle("/pair", pair.Handler(st, execPair))
	addr := "127.0.0.1:49400"
	fmt.Fprintln(w, "ocd serve on http://"+addr+" (telegram polling + /pair)")
	return http.ListenAndServe(addr, mux)
}
