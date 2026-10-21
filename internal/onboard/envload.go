package onboard

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// homeDir returns the user's home directory, or "" when it cannot be read.
func homeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

// LoadEnvFile parses a KEY="value" env file (comments and blanks ignored).
// Both quote styles are stripped, as systemd's EnvironmentFile= does.
// Only OCD_* keys are returned; anything else is left for the shell.
func LoadEnvFile(path string) (map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	out := map[string]string{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !ok || !strings.HasPrefix(key, "OCD_") || !validEnvKey(key) {
			continue
		}
		val = strings.TrimSpace(val)
		val = unquoteEnvValue(val)
		// $HOME is expanded here because not every consumer of this file
		// expands it: systemd's EnvironmentFile= takes values literally,
		// which once pointed the daemon at a literal "$HOME" directory.
		val = strings.ReplaceAll(val, "${HOME}", homeDir())
		val = strings.ReplaceAll(val, "$HOME", homeDir())
		out[key] = val
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("onboard: read env: %w", err)
	}
	return out, nil
}

// unquoteEnvValue removes one layer of quoting from an env file value.
// systemd's EnvironmentFile= takes both quote styles and strips them, so
// the Go reader must do the same: a value written KEY='secret' otherwise
// arrives with its quotes still glued on. A value in neither quoted form
// stays as it is.
func unquoteEnvValue(val string) string {
	if unq, err := strconv.Unquote(val); err == nil {
		return unq
	}
	if len(val) >= 2 && strings.HasPrefix(val, "'") && strings.HasSuffix(val, "'") {
		return val[1 : len(val)-1]
	}
	return val
}

// envKeyRunes are the runes an env key may hold besides digits.
const envKeyRunes = "_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// envKeyDigits are the digits an env key may hold, never the first one.
const envKeyDigits = "0123456789"

// validEnvKey reports whether a key may name an env value: letters, an
// underscore, and digits after the first character.
func validEnvKey(key string) bool {
	if len(key) == 0 {
		return false
	}
	for i, r := range key {
		if !validEnvKeyRune(r, i) {
			return false
		}
	}
	return true
}

// validEnvKeyRune reports whether r may hold at position i of an env key.
func validEnvKeyRune(r rune, i int) bool {
	if strings.ContainsRune(envKeyRunes, r) {
		return true
	}
	return i > 0 && strings.ContainsRune(envKeyDigits, r)
}

// Identity is what a box is: its name and the URLs it serves. The URLs
// come from the env file, not from the box name: a box may serve hosts
// that were set up before the naming convention existed.
type Identity struct {
	BoxID     string
	TapURL    string
	UIURL     string
	WorkerURL string
}

// ExistingIdentity reports the identity of an already-onboarded box. A
// missing env file or no box id means a fresh box.
func ExistingIdentity(envPath string) (Identity, bool) {
	vals, err := LoadEnvFile(envPath)
	if err != nil {
		return Identity{}, false
	}
	id := strings.TrimSpace(vals["OCD_BOX_ID"])
	if id == "" {
		return Identity{}, false
	}
	return Identity{
		BoxID:     id,
		TapURL:    strings.TrimSpace(vals["OCD_PUBLIC_URL"]),
		UIURL:     strings.TrimSpace(vals["OCD_PAIR_URL"]),
		WorkerURL: strings.TrimSpace(vals["OCD_WORKER_URL"]),
	}, true
}

// ApplyEnvDefaults fills unset OCD_* vars from the default env file.
// Missing or unreadable file is not an error: explicit environment and
// flags always win, this only removes the need to source ~/.ocd/env.
func ApplyEnvDefaults() {
	path, err := DefaultEnvPath()
	if err != nil {
		return
	}
	vals, err := LoadEnvFile(path)
	if err != nil {
		return
	}
	for k, v := range vals {
		if _, present := os.LookupEnv(k); !present {
			_ = os.Setenv(k, v)
		}
	}
}
