package cli

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"

	"github.com/mfenderov/ocd/internal/hook"
	"github.com/mfenderov/ocd/internal/pair"
	"github.com/mfenderov/ocd/internal/store"
	"github.com/mfenderov/ocd/internal/tg"
)

func RunServe(w io.Writer) error {
	if os.Getenv("OCD_TG_TOKEN") == "" {
		return fmt.Errorf("OCD_TG_TOKEN unset: refusing to run deaf (bot would silently ignore everything)")
	}
	if os.Getenv("OCD_OWNER_ID") == "" {
		return fmt.Errorf("OCD_OWNER_ID unset: refusing to run deaf")
	}
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

	hookPath, hookSecret := setupWebhook(ctx, w, st)
	poll := hookPath == ""
	go func() {
		if err := tg.Start(ctx, st, poll); err != nil {
			fmt.Fprintln(w, "telegram:", err)
		}
	}()

	mux := http.NewServeMux()
	mux.Handle("/pair", pair.Handler(st, execPair))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "ok")
	})

	if poll {
		fmt.Fprintln(w, "mode: polling")
	} else {
		mux.Handle("/webhook/"+hookPath, hook.Handler(st, hookSecret, st.SeenUpdate,
			func(chatID, fromID int64, chatType, text string) {
				tg.Dispatch(ctx, st, chatID, fromID, chatType, text)
			}))
		fmt.Fprintln(w, "mode: webhook (polling off)")
	}

	addr := "127.0.0.1:49400"
	fmt.Fprintln(w, "ocd serve on http://"+addr)
	return http.ListenAndServe(addr, mux)
}

func newSecret() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func newPath() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// setupWebhook registers a rotating-UUID push path with Telegram.
// Empty public base or any failure means polling carries on alone.
func setupWebhook(ctx context.Context, w io.Writer, st *store.Store) (string, string) {
	base := os.Getenv("OCD_WEBHOOK_BASE")
	if base == "" {
		fmt.Fprintln(w, "webhook off (OCD_WEBHOOK_BASE unset), polling only")
		return "", ""
	}
	secret, err := newSecret()
	if err != nil {
		fmt.Fprintln(w, "webhook off (no entropy):", err)
		return "", ""
	}
	path, err := newPath()
	if err != nil {
		fmt.Fprintln(w, "webhook off (no entropy):", err)
		return "", ""
	}
	url := base + "/webhook/" + path
	if err := tg.SetWebhook(ctx, url, secret); err != nil {
		fmt.Fprintln(w, "webhook off (setWebhook failed, polling continues):", err)
		st.Audit("tg:owner", "webhook_failed", "", "", err.Error())
		return "", ""
	}
	st.Audit("tg:owner", "webhook_on", "", "", url)
	fmt.Fprintln(w, "webhook on:", url)
	go func() {
		<-ctx.Done()
		_ = tg.DeleteWebhook(ctx)
	}()
	return path, secret
}
