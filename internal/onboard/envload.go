package onboard

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// LoadEnvFile parses a KEY="value" env file (comments and blanks ignored).
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
		if unq, err := strconv.Unquote(val); err == nil {
			val = unq
		}
		out[key] = val
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("onboard: read env: %w", err)
	}
	return out, nil
}

func validEnvKey(key string) bool {
	for i, r := range key {
		ok := r == '_' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || i > 0 && r >= '0' && r <= '9'
		if !ok {
			return false
		}
	}
	return len(key) > 0
}

// ExistingBox reports a previous onboarding: the box id stored in the env
// file, if any. Missing file or no box id means a fresh box.
func ExistingBox(envPath string) (string, bool) {
	vals, err := LoadEnvFile(envPath)
	if err != nil {
		return "", false
	}
	id := strings.TrimSpace(vals["OCD_BOX_ID"])
	return id, id != ""
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
