package onboard_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mfenderov/ocd/internal/onboard"
)

// plantBoxConfig writes the box's own tunnel config where the repair
// looks for it.
func plantBoxConfig(t *testing.T, home, content string) {
	t.Helper()
	dir := filepath.Join(home, ".cloudflared")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.yml"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestRepairEnvFixesDerivedValues(t *testing.T) {
	dir := t.TempDir()
	// Isolate from this machine's own tunnel config: the repair reads
	// hostnames from it when it exists.
	t.Setenv("HOME", dir)
	envPath := filepath.Join(dir, "env")
	// Stale wiring: tap url without /pair, pair url pointing at the tap host.
	old := "OCD_BOX_ID=\"mac\"\n" +
		"OCD_PUBLIC_URL=\"https://oc-tap-mac.buyallmemes.com\"\n" +
		"OCD_PAIR_URL=\"https://oc-tap-mac.buyallmemes.com\"\n" +
		"OCD_HEARTBEAT_TOKEN=\"keepme\"\n"
	if err := os.WriteFile(envPath, []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	changed, err := onboard.RepairEnv(envPath, "mac")
	if err != nil {
		t.Fatalf("repair: %v", err)
	}
	if len(changed) != 4 {
		t.Fatalf("want 4 changed keys, got %v", changed)
	}
	vals, err := onboard.LoadEnvFile(envPath)
	if err != nil {
		t.Fatal(err)
	}
	if vals["OCD_PUBLIC_URL"] != "https://oc-tap-mac.buyallmemes.com/pair" {
		t.Fatalf("tap url = %q", vals["OCD_PUBLIC_URL"])
	}
	if vals["OCD_PAIR_URL"] != "https://oc-mac.buyallmemes.com" {
		t.Fatalf("pair url = %q", vals["OCD_PAIR_URL"])
	}
	if vals["OCD_PAIR_OPEN"] != "1" {
		t.Fatalf("pair open must be enabled, got %q", vals["OCD_PAIR_OPEN"])
	}
	if vals["OCD_HEARTBEAT_TOKEN"] != "keepme" {
		t.Fatalf("unrelated values must survive, got %q", vals["OCD_HEARTBEAT_TOKEN"])
	}
	// Running again finds nothing to change.
	changed, err = onboard.RepairEnv(envPath, "mac")
	if err != nil {
		t.Fatalf("second repair: %v", err)
	}
	if len(changed) != 0 {
		t.Fatalf("repair must be idempotent, got %v", changed)
	}
}

func TestRepairEnvRefusesOtherBox(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, "env")
	if err := os.WriteFile(envPath, []byte("OCD_BOX_ID=\"home\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := onboard.RepairEnv(envPath, "mac"); err == nil {
		t.Fatal("must refuse to rewrite another box's env")
	}
}

func TestRepairTunnelKeepsTunnelID(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yml")
	const id = "7af02ec2-edc2-4f94-94b3-3e2fa8bcb78f"
	old := "tunnel: " + id + "\n" +
		"credentials-file: " + dir + "/" + id + ".json\n" +
		"ingress:\n" +
		"  - hostname: oc-tap-mac.buyallmemes.com\n    service: http://127.0.0.1:49400\n" +
		"  - hostname: oc-mac.buyallmemes.com\n    service: http://127.0.0.1:49400\n" +
		"  - service: http_status:404\n"
	if err := os.WriteFile(cfgPath, []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	fixed, err := onboard.RepairTunnel(cfgPath, "mac")
	if err != nil {
		t.Fatalf("repair: %v", err)
	}
	if !fixed {
		t.Fatal("stale config must be rewritten")
	}
	raw, _ := os.ReadFile(cfgPath)
	got := string(raw)
	if !strings.Contains(got, "tunnel: "+id) {
		t.Fatalf("must keep the tunnel id, got:\n%s", got)
	}
	// tap host -> daemon, editor host -> OpenCode
	if !strings.Contains(got, "hostname: oc-tap-mac.buyallmemes.com\n    service: http://127.0.0.1:49400") {
		t.Fatalf("tap host must serve the daemon, got:\n%s", got)
	}
	if !strings.Contains(got, "hostname: oc-mac.buyallmemes.com\n    service: http://127.0.0.1:49374") {
		t.Fatalf("editor host must serve OpenCode, got:\n%s", got)
	}
	fixed, err = onboard.RepairTunnel(cfgPath, "mac")
	if err != nil {
		t.Fatalf("second repair: %v", err)
	}
	if fixed {
		t.Fatal("repair must be idempotent")
	}
}

// The tunnel config is the source of truth for hostnames: the primary
// box does not follow the naming convention, and repair must not
// rewrite its hostnames.
func TestRepairTunnelKeepsHostnamesAndFixesPorts(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	// No opencode on PATH: the editor port falls back to the default.
	t.Setenv("PATH", t.TempDir())
	cfgPath := filepath.Join(dir, "config.yml")
	const id = "7ed965a2-9828-46f6-851e-24cf1b9fedf6"
	old := "tunnel: " + id + "\n" +
		"credentials-file: " + dir + "/" + id + ".json\n" +
		"ingress:\n" +
		"  - hostname: oc-tap.buyallmemes.com\n    service: http://127.0.0.1:49400\n" +
		"  - hostname: oc.buyallmemes.com\n    service: http://127.0.0.1:30000\n" +
		"  - service: http_status:404\n"
	if err := os.WriteFile(cfgPath, []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	fixed, err := onboard.RepairTunnel(cfgPath, "home")
	if err != nil {
		t.Fatalf("repair: %v", err)
	}
	if !fixed {
		t.Fatal("config should be rewritten")
	}
	raw, _ := os.ReadFile(cfgPath)
	got := string(raw)
	for _, want := range []string{"oc-tap.buyallmemes.com", "oc.buyallmemes.com", "49400", ":49374"} {
		if !strings.Contains(got, want) {
			t.Fatalf("must keep %q, got:\n%s", want, got)
		}
	}
	if strings.Contains(got, "oc-tap-home") || strings.Contains(got, "oc-home") {
		t.Fatalf("repair must not invent hostnames, got:\n%s", got)
	}
}

// The repair prefers the box's own name: a config that serves the old
// name first must not revert the public URL to it.
func TestRepairEnvPrefersTheBoxsOwnTapHost(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	// The box's own config: the old names first, its own names after.
	plantBoxConfig(t, dir, "ingress:\n"+
		"  - hostname: oc-tap.buyallmemes.com\n    service: http://127.0.0.1:49400\n"+
		"  - hostname: oc.buyallmemes.com\n    service: http://127.0.0.1:49374\n"+
		"  - hostname: oc-tap-home.buyallmemes.com\n    service: http://127.0.0.1:49400\n"+
		"  - hostname: oc-home.buyallmemes.com\n    service: http://127.0.0.1:49374\n")
	envPath := filepath.Join(dir, "env")
	if err := os.WriteFile(envPath, []byte("OCD_BOX_ID=\"home\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := onboard.RepairEnv(envPath, "home"); err != nil {
		t.Fatalf("repair: %v", err)
	}
	vals, err := onboard.LoadEnvFile(envPath)
	if err != nil {
		t.Fatal(err)
	}
	if vals["OCD_PUBLIC_URL"] != "https://oc-tap-home.buyallmemes.com/pair" {
		t.Fatalf("the tap url must not go back to the old host, got %q", vals["OCD_PUBLIC_URL"])
	}
	if vals["OCD_PAIR_URL"] != "https://oc-home.buyallmemes.com" {
		t.Fatalf("the pair url must be the box's own host, got %q", vals["OCD_PAIR_URL"])
	}
}

// The merged config — the old names and the new ones — survives the
// repair: the four rules keep their ports and the catch-all stays.
func TestRepairTunnelLeavesTheMergedConfigAlone(t *testing.T) {
	dir := t.TempDir()
	// No opencode on PATH: the editor port falls back to the default.
	t.Setenv("PATH", t.TempDir())
	cfgPath := filepath.Join(dir, "config.yml")
	const id = "7ed965a2-9828-46f6-851e-24cf1b9fedf6"
	old := "tunnel: " + id + "\n" +
		"credentials-file: " + dir + "/" + id + ".json\n" +
		"ingress:\n" +
		"  - hostname: oc-tap-home.buyallmemes.com\n    service: http://127.0.0.1:49400\n" +
		"  - hostname: oc-home.buyallmemes.com\n    service: http://127.0.0.1:49374\n" +
		"  - hostname: oc-tap.buyallmemes.com\n    service: http://127.0.0.1:49400\n" +
		"  - hostname: oc.buyallmemes.com\n    service: http://127.0.0.1:49374\n" +
		"  - service: http_status:404\n"
	if err := os.WriteFile(cfgPath, []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	fixed, err := onboard.RepairTunnel(cfgPath, "home")
	if err != nil {
		t.Fatalf("repair: %v", err)
	}
	if fixed {
		t.Fatal("the merged config is already correct: nothing to write")
	}
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != old {
		t.Fatalf("the config must be left alone, got:\n%s", raw)
	}
}

// A rule the repair cannot pair is never written: the pairing shifts
// and the tap rule would be written with the editor's port.
func TestRepairTunnelRefusesAConfigItCannotPair(t *testing.T) {
	const id = "7ed965a2-9828-46f6-851e-24cf1b9fedf6"
	cases := []struct {
		name string
		rule string
		want string
	}{
		{
			name: "a service the repair cannot read",
			rule: "  - hostname: oc-tap-home.buyallmemes.com\n    service: unix:/run/ocd.sock\n",
			want: "oc-tap-home.buyallmemes.com",
		},
		{
			name: "a rule with no service",
			rule: "  - hostname: oc-tap-home.buyallmemes.com\n",
			want: "oc-tap-home.buyallmemes.com",
		},
		{
			name: "a service with no hostname",
			rule: "  - service: http://127.0.0.1:49400\n",
			want: "http://127.0.0.1:49400",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			// No opencode on PATH: nothing is asked of the machine.
			t.Setenv("PATH", t.TempDir())
			cfgPath := filepath.Join(dir, "config.yml")
			old := "tunnel: " + id + "\n" +
				"credentials-file: " + dir + "/" + id + ".json\n" +
				"ingress:\n" +
				tc.rule +
				"  - hostname: oc-home.buyallmemes.com\n    service: http://127.0.0.1:49374\n" +
				"  - service: http_status:404\n"
			if err := os.WriteFile(cfgPath, []byte(old), 0o600); err != nil {
				t.Fatal(err)
			}
			fixed, err := onboard.RepairTunnel(cfgPath, "home")
			if err == nil {
				t.Fatal("a config whose rules cannot be paired must be refused")
			}
			if fixed {
				t.Fatal("a refused config must not be written")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("the error must name what it found (%q), got: %v", tc.want, err)
			}
			raw, err := os.ReadFile(cfgPath)
			if err != nil {
				t.Fatal(err)
			}
			if string(raw) != old {
				t.Fatalf("the config must be left alone, got:\n%s", raw)
			}
		})
	}
}

func TestParseIngress(t *testing.T) {
	raw := "ingress:\n" +
		"  - hostname: a.example.com\n    service: http://127.0.0.1:49400\n" +
		"  - hostname: b.example.com\n    service: http://127.0.0.1:31047\n" +
		"  - service: http_status:404\n"
	rules := onboard.ParseIngress(raw)
	if len(rules) != 2 {
		t.Fatalf("want 2 rules, got %+v", rules)
	}
	if rules[0].Hostname != "a.example.com" || rules[0].Port != 49400 {
		t.Fatalf("rule 0 = %+v", rules[0])
	}
	if rules[1].Hostname != "b.example.com" || rules[1].Port != 31047 {
		t.Fatalf("rule 1 = %+v", rules[1])
	}
}
