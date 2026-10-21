package onboard_test

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mfenderov/ocd/internal/onboard"
)

const listJSON = `[{"id":"11111111-2222-3333-4444-555555555555","name":"oc-mac",` +
	`"created_at":"2026-10-19T00:00:00Z","deleted_at":"0001-01-01T00:00:00Z","connections":[]}]`

func plantCert(t *testing.T, dir string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "cert.pem"), []byte("fake-cert"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLOUDFLARE_API_TOKEN", "")
}

func TestListTunnelsParsesNames(t *testing.T) {
	recordingCloudflared(t, map[string]string{"tunnel list": listJSON}, nil)
	got, err := onboard.ListTunnels(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if got["oc-mac"] != "11111111-2222-3333-4444-555555555555" {
		t.Fatalf("want id for oc-mac, got %v", got)
	}
}

func TestSetupTunnelFullFlow(t *testing.T) {
	recordingCloudflared(t, map[string]string{
		"tunnel list": `[]`,
		"tunnel create": "Created tunnel oc-mac with id aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n" +
			"Tunnel credentials written to /tmp/x/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json",
		"tunnel route": `Added CNAME oc-tap-mac.buyallmemes.com to oc-mac`,
	}, nil)
	dir := t.TempDir()
	plantCert(t, dir)
	plan := onboard.TunnelPlan{
		Name: "oc-mac", TapHost: "oc-tap-mac.buyallmemes.com", UIHost: "",
		CredDir: dir, Port: 49400,
	}
	setup, err := onboard.SetupTunnel(context.Background(), plan, func(string) {})
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	if setup.ID != "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" {
		t.Fatalf("want parsed tunnel id, got %q", setup.ID)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "config.yml"))
	if err != nil {
		t.Fatalf("config not written: %v", err)
	}
	for _, want := range []string{"oc-tap-mac.buyallmemes.com", "49400", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("config must contain %q, got:\n%s", want, raw)
		}
	}
}

func TestSetupTunnelReusesExisting(t *testing.T) {
	recordingCloudflared(t, map[string]string{"tunnel list": listJSON}, nil)
	dir := t.TempDir()
	plantCert(t, dir)
	plan := onboard.TunnelPlan{
		Name: "oc-mac", TapHost: "oc-tap-mac.buyallmemes.com",
		CredDir: dir, Port: 49400,
	}
	setup, err := onboard.SetupTunnel(context.Background(), plan, func(string) {})
	if err != nil {
		t.Fatalf("reuse: %v", err)
	}
	if setup.ID != "11111111-2222-3333-4444-555555555555" {
		t.Fatalf("must reuse existing tunnel, got %q", setup.ID)
	}
}

// A file that is not a tunnel config is never replaced: its rules cannot
// be read, so no merge can promise to keep them.
func TestSetupTunnelRefusesToClobberAnUnknownConfig(t *testing.T) {
	recordingCloudflared(t, map[string]string{
		"tunnel list":   `[]`,
		"tunnel create": "id 99999999-0000-0000-0000-000000000000",
	}, nil)
	dir := t.TempDir()
	plantCert(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "config.yml"), []byte("existing"), 0o600); err != nil {
		t.Fatal(err)
	}
	plan := onboard.TunnelPlan{Name: "oc-x", TapHost: "oc-tap-x.buyallmemes.com", CredDir: dir, Port: 49400}
	if _, err := onboard.SetupTunnel(context.Background(), plan, func(string) {}); err == nil {
		t.Fatal("must not overwrite a file that is not a tunnel config")
	}
	raw, err := os.ReadFile(filepath.Join(dir, "config.yml"))
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "existing" {
		t.Fatalf("the file must be left alone, got:\n%s", raw)
	}
}

// plantConfig writes a tunnel config for a test.
func plantConfig(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// recordingCloudflared installs a fake cloudflared that answers canned
// outputs and appends every invocation to a file, so a test can see
// which calls were made. It returns the path of that file. The fail map
// names the keys the stub must fail on.
func recordingCloudflared(t *testing.T, handlers map[string]string, fail map[string]bool) string {
	t.Helper()
	dir := t.TempDir()
	calls := filepath.Join(dir, "calls")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '" + calls + "'\nkey=\"$1 $2\"\n" +
		"case \"$key\" in\n"
	for k, out := range handlers {
		script += "  \"" + k + "\") printf '%s' '" + out + "';;\n"
	}
	script += "esac\n"
	for k := range fail {
		script += `if [ "$key" = "` + k + `" ]; then exit 1; fi` + "\n"
	}
	script += "exit 0\n"
	p := filepath.Join(dir, "cloudflared")
	//nolint:gosec // the stub binary must be executable: it stands in for a real one.
	if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	return calls
}

// cloudflaredCalls returns the invocations the fake recorded.
func cloudflaredCalls(t *testing.T, path string) []string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatal(err)
	}
	var calls []string
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if line != "" {
			calls = append(calls, line)
		}
	}
	return calls
}

// callsContain reports whether one of the recorded calls says all of it.
func callsContain(calls []string, parts ...string) bool {
	for _, call := range calls {
		says := true
		for _, p := range parts {
			if !strings.Contains(call, p) {
				says = false
				break
			}
		}
		if says {
			return true
		}
	}
	return false
}

// assertNoTunnelCreated fails when the fake was asked to create a tunnel.
func assertNoTunnelCreated(t *testing.T, calls []string) {
	t.Helper()
	for _, call := range calls {
		if strings.HasPrefix(call, "tunnel create") {
			t.Fatalf("the box must not get a second tunnel, saw %q", call)
		}
	}
}

// logMentions reports whether one of the progress lines says all of it.
func logMentions(log []string, parts ...string) bool {
	for _, line := range log {
		says := true
		for _, p := range parts {
			if !strings.Contains(line, p) {
				says = false
				break
			}
		}
		if says {
			return true
		}
	}
	return false
}

// A box's own config names the tunnel the box serves. That id wins over
// the plan's name: the name is a label, the id is the identity. The box
// must not get a second tunnel — the old names' DNS still points at the
// one it runs.
func TestSetupTunnelReusesTheTunnelItsOwnConfigNames(t *testing.T) {
	const own = "7ed965a2-9828-46f6-851e-24cf1b9fedf6"
	const planned = "99999999-8888-7777-6666-555555555555"
	callsFile := recordingCloudflared(t, map[string]string{
		"tunnel list":  `[{"id":"` + own + `","name":"oc-wsl"},{"id":"` + planned + `","name":"oc-home"}]`,
		"tunnel route": `Added CNAME`,
	}, map[string]bool{"tunnel create": true})
	dir := t.TempDir()
	plantCert(t, dir)
	plantConfig(t, filepath.Join(dir, "config.yml"),
		"tunnel: "+own+"\n"+
			"credentials-file: "+filepath.Join(dir, own+".json")+"\n"+
			"ingress:\n"+
			"  - hostname: oc-tap.buyallmemes.com\n    service: http://127.0.0.1:49500\n"+
			"  - service: http_status:404\n")

	var log []string
	plan := onboard.TunnelPlan{
		Name: "oc-home", TapHost: conventionalTap, UIHost: conventionalUI,
		CredDir: dir, Port: 49400, UIPort: 49374,
	}
	setup, err := onboard.SetupTunnel(context.Background(), plan, func(s string) { log = append(log, s) })
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	if setup.ID != own {
		t.Fatalf("the box's own tunnel must win over the plan's name, got %q", setup.ID)
	}
	assertNoTunnelCreated(t, cloudflaredCalls(t, callsFile))
	if !logMentions(log, own, "oc-home") {
		t.Fatalf("the log must say which tunnel the box serves, got %v", log)
	}
}

// A box with no config of its own creates the tunnel the plan names: the
// fresh box's path, unchanged.
func TestSetupTunnelCreatesTheTunnelForABoxWithNoConfig(t *testing.T) {
	const created = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	callsFile := recordingCloudflared(t, map[string]string{
		"tunnel list":   `[]`,
		"tunnel create": "Created tunnel oc-fresh with id " + created,
		"tunnel route":  `Added CNAME`,
	}, nil)
	dir := t.TempDir()
	plantCert(t, dir)

	plan := onboard.TunnelPlan{Name: "oc-fresh", TapHost: "oc-tap-fresh.example.com", CredDir: dir, Port: 49400}
	setup, err := onboard.SetupTunnel(context.Background(), plan, nil)
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	if setup.ID != created {
		t.Fatalf("want the created tunnel id, got %q", setup.ID)
	}
	calls := cloudflaredCalls(t, callsFile)
	if !callsContain(calls, "tunnel create oc-fresh") {
		t.Fatalf("the tunnel must be created, saw %v", calls)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "config.yml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), created) {
		t.Fatalf("the config must serve the created tunnel, got:\n%s", raw)
	}
}

// A box that has a config of its own never gets a second tunnel: a
// config that names no tunnel is refused, not replaced.
func TestSetupTunnelRefusesAConfigThatNamesNoTunnel(t *testing.T) {
	callsFile := recordingCloudflared(t, map[string]string{
		"tunnel list":   `[]`,
		"tunnel create": "Created tunnel oc-x with id 99999999-0000-0000-0000-000000000000",
	}, nil)
	dir := t.TempDir()
	plantCert(t, dir)
	plantConfig(t, filepath.Join(dir, "config.yml"), "not a tunnel config\n")

	plan := onboard.TunnelPlan{Name: "oc-x", TapHost: "oc-tap-x.example.com", CredDir: dir, Port: 49400}
	if _, err := onboard.SetupTunnel(context.Background(), plan, nil); err == nil {
		t.Fatal("a config that names no tunnel must not be replaced by a new tunnel")
	}
	assertNoTunnelCreated(t, cloudflaredCalls(t, callsFile))
}

// The DNS records may be missing even when the config is already the
// desired set: the brain writes them too, and a box set up before the
// brain owned the DNS has none. The route runs anyway — it overwrites.
func TestSetupTunnelRoutesTheDNSWhenTheConfigIsReused(t *testing.T) {
	const id = "7ed965a2-9828-46f6-851e-24cf1b9fedf6"
	callsFile := recordingCloudflared(t, map[string]string{
		"tunnel list":  `[{"id":"` + id + `","name":"oc-wsl"}]`,
		"tunnel route": `Added CNAME`,
	}, map[string]bool{"tunnel create": true})
	dir := t.TempDir()
	plantCert(t, dir)
	plantConfig(t, filepath.Join(dir, "config.yml"),
		"tunnel: "+id+"\n"+
			"credentials-file: "+filepath.Join(dir, id+".json")+"\n"+
			"ingress:\n"+
			"  - hostname: "+conventionalTap+"\n    service: http://127.0.0.1:49400\n"+
			"  - hostname: "+conventionalUI+"\n    service: http://127.0.0.1:49374\n"+
			"  - service: http_status:404\n")

	plan := onboard.TunnelPlan{
		Name: "oc-home", TapHost: conventionalTap, UIHost: conventionalUI,
		CredDir: dir, Port: 49400, UIPort: 49374,
	}
	if _, err := onboard.SetupTunnel(context.Background(), plan, nil); err != nil {
		t.Fatalf("setup: %v", err)
	}
	calls := cloudflaredCalls(t, callsFile)
	for _, host := range []string{conventionalTap, conventionalUI} {
		if !callsContain(calls, "tunnel route dns", id, host) {
			t.Fatalf("the DNS for %s must be routed, saw %v", host, calls)
		}
	}
}

// homeConfig is the box's own config: the old names, on the ports the
// old names had — not the conventional ones, so a merge that gave the old
// rules the conventional ports would show.
func homeConfig(id, cred string) string {
	return "tunnel: " + id + "\n" +
		"credentials-file: " + cred + "\n" +
		"ingress:\n" +
		"  - hostname: oc-tap.buyallmemes.com\n    service: http://127.0.0.1:49500\n" +
		"  - hostname: oc.buyallmemes.com\n    service: http://127.0.0.1:30111\n" +
		"  - service: http_status:404\n"
}

const (
	conventionalTap = "oc-tap-home.buyallmemes.com"
	conventionalUI  = "oc-home.buyallmemes.com"
)

// The box's config already serves the old names. The new config serves
// them too: a tap link the owner already holds must keep working.
func TestEnsureTunnelConfigServesTheOldNamesAndTheNewOnes(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	const id = "7ed965a2-9828-46f6-851e-24cf1b9fedf6"
	cred := filepath.Join(dir, id+".json")
	plantConfig(t, path, homeConfig(id, cred))

	reused, err := onboard.EnsureTunnelConfig(path, id, cred, conventionalTap, conventionalUI, 49400, 49374)
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if reused {
		t.Fatal("the conventional hosts are missing: the config must be written")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := "tunnel: " + id + "\n" +
		"credentials-file: " + cred + "\n" +
		"ingress:\n" +
		"  - hostname: " + conventionalTap + "\n    service: http://127.0.0.1:49400\n" +
		"  - hostname: " + conventionalUI + "\n    service: http://127.0.0.1:49374\n" +
		"  - hostname: oc-tap.buyallmemes.com\n    service: http://127.0.0.1:49500\n" +
		"  - hostname: oc.buyallmemes.com\n    service: http://127.0.0.1:30111\n" +
		"  - service: http_status:404\n"
	if string(raw) != want {
		t.Fatalf("the config must serve the old names and the new ones, got:\n%s", raw)
	}
	// The old rules keep the ports they had; the conventional ones get
	// the ports of the plan.
	for _, rule := range []string{
		"hostname: oc-tap.buyallmemes.com\n    service: http://127.0.0.1:49500",
		"hostname: oc.buyallmemes.com\n    service: http://127.0.0.1:30111",
		"hostname: " + conventionalTap + "\n    service: http://127.0.0.1:49400",
		"hostname: " + conventionalUI + "\n    service: http://127.0.0.1:49374",
	} {
		if !strings.Contains(string(raw), rule) {
			t.Fatalf("want the rule %q in:\n%s", rule, raw)
		}
	}
}

// A config the operator hand-tuned keeps its rules: the new config is a
// superset of the old one, never a replacement.
func TestEnsureTunnelConfigKeepsAnOperatorRule(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	const id = "7ed965a2-9828-46f6-851e-24cf1b9fedf6"
	cred := filepath.Join(dir, id+".json")
	plantConfig(t, path, "tunnel: "+id+"\n"+
		"credentials-file: "+cred+"\n"+
		"ingress:\n"+
		"  - hostname: oc-tap.buyallmemes.com\n    service: http://127.0.0.1:49500\n"+
		"  - hostname: oc.buyallmemes.com\n    service: http://127.0.0.1:30111\n"+
		"  - hostname: oc-extra.buyallmemes.com\n    service: http://127.0.0.1:31047\n"+
		"  - service: http_status:404\n")

	if _, err := onboard.EnsureTunnelConfig(path, id, cred, conventionalTap, conventionalUI, 49400, 49374); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := "tunnel: " + id + "\n" +
		"credentials-file: " + cred + "\n" +
		"ingress:\n" +
		"  - hostname: " + conventionalTap + "\n    service: http://127.0.0.1:49400\n" +
		"  - hostname: " + conventionalUI + "\n    service: http://127.0.0.1:49374\n" +
		"  - hostname: oc-tap.buyallmemes.com\n    service: http://127.0.0.1:49500\n" +
		"  - hostname: oc.buyallmemes.com\n    service: http://127.0.0.1:30111\n" +
		"  - hostname: oc-extra.buyallmemes.com\n    service: http://127.0.0.1:31047\n" +
		"  - service: http_status:404\n"
	if string(raw) != want {
		t.Fatalf("the operator's own rule must survive, got:\n%s", raw)
	}
}

// A config that already serves the conventional hosts is reused: a
// re-run writes nothing at all.
func TestEnsureTunnelConfigReusesAConfigThatAlreadyServesThem(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	const id = "7ed965a2-9828-46f6-851e-24cf1b9fedf6"
	cred := filepath.Join(dir, id+".json")
	plantConfig(t, path, "tunnel: "+id+"\n"+
		"credentials-file: "+cred+"\n"+
		"ingress:\n"+
		"  - hostname: "+conventionalTap+"\n    service: http://127.0.0.1:49400\n"+
		"  - hostname: "+conventionalUI+"\n    service: http://127.0.0.1:49374\n"+
		"  - hostname: oc-tap.buyallmemes.com\n    service: http://127.0.0.1:49400\n"+
		"  - hostname: oc.buyallmemes.com\n    service: http://127.0.0.1:49374\n"+
		"  - service: http_status:404\n"+
		"# the operator's own note\n")

	reused, err := onboard.EnsureTunnelConfig(path, id, cred, conventionalTap, conventionalUI, 49400, 49374)
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if !reused {
		t.Fatal("the config already serves the conventional hosts: nothing to write")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "# the operator's own note") {
		t.Fatalf("a reused config must not be rewritten, got:\n%s", raw)
	}
}

// A box with no config gets the conventional rules.
func TestEnsureTunnelConfigWritesTheConventionalRulesForANewBox(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	const id = "11111111-2222-3333-4444-555555555555"
	cred := filepath.Join(dir, id+".json")

	reused, err := onboard.EnsureTunnelConfig(path, id, cred, conventionalTap, conventionalUI, 49400, 49374)
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if reused {
		t.Fatal("there was no config to reuse")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := "tunnel: " + id + "\n" +
		"credentials-file: " + cred + "\n" +
		"ingress:\n" +
		"  - hostname: " + conventionalTap + "\n    service: http://127.0.0.1:49400\n" +
		"  - hostname: " + conventionalUI + "\n    service: http://127.0.0.1:49374\n" +
		"  - service: http_status:404\n"
	if string(raw) != want {
		t.Fatalf("a new box must get the conventional rules, got:\n%s", raw)
	}
}

// A rule this build cannot read is never lost: the config is left
// alone, because no merge can promise to keep what it cannot see.
func TestEnsureTunnelConfigRefusesAConfigItCannotCopy(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	const id = "7ed965a2-9828-46f6-851e-24cf1b9fedf6"
	cred := filepath.Join(dir, id+".json")
	plantConfig(t, path, "tunnel: "+id+"\n"+
		"credentials-file: "+cred+"\n"+
		"ingress:\n"+
		"  - hostname: oc-tap.buyallmemes.com\n    service: http://127.0.0.1:49500\n"+
		"  - hostname: elsewhere.example.com\n    service: https://elsewhere.example.com\n"+
		"  - service: http_status:404\n")

	if _, err := onboard.EnsureTunnelConfig(path, id, cred, conventionalTap, conventionalUI, 49400, 49374); err == nil {
		t.Fatal("a rule that cannot be copied must not be dropped")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "elsewhere.example.com") {
		t.Fatalf("the config must be left alone, got:\n%s", raw)
	}
}

// The writer emits a fixed shape. A config that holds anything else would
// lose it in a rewrite, so the merge refuses and names what it found.
func TestEnsureTunnelConfigRefusesWhatItCannotReproduce(t *testing.T) {
	const id = "7ed965a2-9828-46f6-851e-24cf1b9fedf6"
	cases := []struct {
		name string
		rule string
		want string
	}{
		{
			name: "a trailing comment",
			rule: "  - hostname: oc-tap.buyallmemes.com # the old name\n    service: http://127.0.0.1:49500\n",
			want: "oc-tap.buyallmemes.com",
		},
		{
			name: "the flow style",
			rule: "  - {hostname: oc-tap.buyallmemes.com, service: http://127.0.0.1:49500}\n",
			want: "oc-tap.buyallmemes.com",
		},
		{
			name: "an option under a rule",
			rule: "  - hostname: oc-tap.buyallmemes.com\n    service: http://127.0.0.1:49500\n" +
				"    originRequest:\n      httpHostHeader: example.com\n",
			want: "originRequest",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "config.yml")
			cred := filepath.Join(dir, id+".json")
			plantConfig(t, path, "tunnel: "+id+"\n"+
				"credentials-file: "+cred+"\n"+
				"ingress:\n"+
				tc.rule+
				"  - hostname: oc.buyallmemes.com\n    service: http://127.0.0.1:30111\n"+
				"  - service: http_status:404\n")

			_, err := onboard.EnsureTunnelConfig(path, id, cred, conventionalTap, conventionalUI, 49400, 49374)
			if err == nil {
				t.Fatal("the merge must refuse a config it cannot reproduce")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("the error must name what it found (%q), got: %v", tc.want, err)
			}
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(raw), tc.rule) {
				t.Fatalf("the config must be left alone, got:\n%s", raw)
			}
		})
	}
}

// Another top-level key is the operator's: a rewrite would drop it.
func TestEnsureTunnelConfigRefusesAnotherTopLevelKey(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	const id = "7ed965a2-9828-46f6-851e-24cf1b9fedf6"
	cred := filepath.Join(dir, id+".json")
	plantConfig(t, path, "tunnel: "+id+"\n"+
		"credentials-file: "+cred+"\n"+
		"warp-routing: true\n"+
		"ingress:\n"+
		"  - hostname: oc-tap.buyallmemes.com\n    service: http://127.0.0.1:49500\n"+
		"  - service: http_status:404\n")

	_, err := onboard.EnsureTunnelConfig(path, id, cred, conventionalTap, conventionalUI, 49400, 49374)
	if err == nil {
		t.Fatal("the merge must refuse a config it cannot reproduce")
	}
	if !strings.Contains(err.Error(), "warp-routing") {
		t.Fatalf("the error must name the top-level key, got: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "warp-routing") {
		t.Fatalf("the config must be left alone, got:\n%s", raw)
	}
}

// The merge never re-points the box: a config that serves another tunnel
// is refused, and the operator sees both ids.
func TestEnsureTunnelConfigRefusesAnotherTunnelsConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	const id = "7ed965a2-9828-46f6-851e-24cf1b9fedf6"
	const other = "99999999-8888-7777-6666-555555555555"
	cred := filepath.Join(dir, id+".json")
	plantConfig(t, path, homeConfig(id, cred))

	_, err := onboard.EnsureTunnelConfig(path, other, filepath.Join(dir, other+".json"),
		conventionalTap, conventionalUI, 49400, 49374)
	if err == nil {
		t.Fatal("a config that serves another tunnel must not be re-pointed")
	}
	if !strings.Contains(err.Error(), id) || !strings.Contains(err.Error(), other) {
		t.Fatalf("the error must name both tunnels, got: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "tunnel: "+id) {
		t.Fatalf("the config must be left alone, got:\n%s", raw)
	}
}

// One hostname, one rule: cloudflared refuses a config that serves the
// same host twice.
func TestEnsureTunnelConfigWritesOneRulePerHostname(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	const id = "11111111-2222-3333-4444-555555555555"
	cred := filepath.Join(dir, id+".json")

	if _, err := onboard.EnsureTunnelConfig(path, id, cred,
		"oc-x.buyallmemes.com", "oc-x.buyallmemes.com", 49400, 49374); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(string(raw), "hostname: oc-x.buyallmemes.com"); n != 1 {
		t.Fatalf("want one rule for the hostname, got %d:\n%s", n, raw)
	}
}

// A config that cannot be read is never written over either: the read
// fails first, and the operator sees why.
func TestEnsureTunnelConfigRefusesAnUnreadableConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	const id = "7ed965a2-9828-46f6-851e-24cf1b9fedf6"
	cred := filepath.Join(dir, id+".json")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := onboard.EnsureTunnelConfig(path, id, cred, conventionalTap, conventionalUI, 49400, 49374); err == nil {
		t.Fatal("a config that cannot be read must not be replaced")
	}
}

func TestTunnelDefaults(t *testing.T) {
	name, ui := onboard.TunnelDefaults("mac", "oc-tap-mac.buyallmemes.com")
	if name != "oc-mac" {
		t.Fatalf("tunnel name = %q", name)
	}
	if ui != "oc-mac.buyallmemes.com" {
		t.Fatalf("ui host = %q", ui)
	}
	if _, ui2 := onboard.TunnelDefaults("mac", "localhost"); ui2 != "" {
		t.Fatalf("bare hostnames get no UI default, got %q", ui2)
	}
}

func TestSetupTunnelRequiresLoginOrToken(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLOUDFLARE_API_TOKEN", "")
	plan := onboard.TunnelPlan{Name: "oc-x", TapHost: "oc-tap-x.example.com", CredDir: dir, Port: 49400}
	if _, err := onboard.SetupTunnel(context.Background(), plan, nil); err == nil {
		t.Fatal("must refuse without login or API token")
	}
}

func TestSetupTunnelReusesIdenticalConfig(t *testing.T) {
	recordingCloudflared(t, map[string]string{
		"tunnel list":   `[]`,
		"tunnel create": "Created tunnel oc-dup with id 11111111-1111-1111-1111-111111111111",
		"tunnel route":  `Added CNAME`,
	}, nil)
	dir := t.TempDir()
	plantCert(t, dir)
	plan := onboard.TunnelPlan{Name: "oc-dup", TapHost: "oc-tap-dup.example.com", CredDir: dir, Port: 49400}
	if _, err := onboard.SetupTunnel(context.Background(), plan, nil); err != nil {
		t.Fatalf("first setup: %v", err)
	}
	setup, err := onboard.SetupTunnel(context.Background(), plan, nil)
	if err != nil {
		t.Fatalf("identical rerun must pass through, got: %v", err)
	}
	if setup.ID != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("want same tunnel id, got %q", setup.ID)
	}
}

// A re-onboard runs the DNS route again, and the brain owns these
// records too: cloudflared refuses to create a record that already
// exists, so the route must overwrite it. Otherwise the onboard aborts
// on a Cloudflare error the operator has no lever for.
func TestRouteDNSOverwritesAnExistingRecord(t *testing.T) {
	dir := t.TempDir()
	args := filepath.Join(dir, "args")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '" + args + "'\nexit 0\n"
	//nolint:gosec // the stub binary must be executable: it stands in for a real one.
	if err := os.WriteFile(filepath.Join(dir, "cloudflared"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))

	if err := onboard.RouteDNS(context.Background(), "token-1", "tun-1", "oc-tap-mac.buyallmemes.com"); err != nil {
		t.Fatalf("route: %v", err)
	}
	raw, err := os.ReadFile(args)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "--overwrite-dns") {
		t.Fatalf("the route must overwrite an existing record, got args %q", strings.TrimSpace(string(raw)))
	}
}

func TestEnsureLoginRequiresProof(t *testing.T) {
	dir := t.TempDir()
	if err := onboard.EnsureCloudflaredLogin(context.Background(), dir, "", false, io.Discard); err == nil {
		t.Fatal("no cert, no token, non-interactive must fail with instructions")
	} else if !strings.Contains(err.Error(), "tunnel login") {
		t.Fatalf("error must name the fix, got: %v", err)
	}
	plantCert(t, dir)
	if err := onboard.EnsureCloudflaredLogin(context.Background(), dir, "", false, io.Discard); err != nil {
		t.Fatalf("cert present means go: %v", err)
	}
}
