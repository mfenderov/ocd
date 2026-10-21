package onboard_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/mfenderov/ocd/internal/onboard"
)

// plantIngressConfig writes a tunnel config for a test and returns its path.
func plantIngressConfig(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// RenderIngress keeps its shape: a rule list in, a config out.
func TestRenderIngressWritesTheRulesAndTheCatchAll(t *testing.T) {
	rules := onboard.ParseIngress("ingress:\n" +
		"  - hostname: a.example.com\n    service: http://127.0.0.1:49400\n" +
		"  - hostname: b.example.com\n    service: http://127.0.0.1:49374\n")
	got := onboard.RenderIngress("tun-1", "/tmp/tun-1.json", rules)
	want := "tunnel: tun-1\n" +
		"credentials-file: /tmp/tun-1.json\n" +
		"ingress:\n" +
		"  - hostname: a.example.com\n    service: http://127.0.0.1:49400\n" +
		"  - hostname: b.example.com\n    service: http://127.0.0.1:49374\n" +
		"  - service: http_status:404\n"
	if got != want {
		t.Fatalf("render:\ngot:\n%s\nwant:\n%s", got, want)
	}
}

// What the writer writes is what the reader reads back: the merge can be
// run again without changing anything.
func TestParseIngressReadsBackWhatRenderIngressWrote(t *testing.T) {
	before := onboard.ParseIngress("ingress:\n" +
		"  - hostname: oc-tap-home.buyallmemes.com\n    service: http://127.0.0.1:49400\n" +
		"  - hostname: oc-home.buyallmemes.com\n    service: http://127.0.0.1:49374\n" +
		"  - hostname: oc-tap.buyallmemes.com\n    service: http://127.0.0.1:49400\n" +
		"  - hostname: oc.buyallmemes.com\n    service: http://127.0.0.1:49374\n")
	after := onboard.ParseIngress(onboard.RenderIngress("tun-1", "/tmp/tun-1.json", before))
	if len(after) != len(before) {
		t.Fatalf("want %d rules back, got %d", len(before), len(after))
	}
	for i := range before {
		if after[i] != before[i] {
			t.Fatalf("rule %d: got %+v, want %+v", i, after[i], before[i])
		}
	}
}

// The box's own name wins: a config that serves both the old name and
// the conventional one keeps the conventional one, so a repair never
// reverts the box to the host it used to serve. The order of the rules
// does not matter.
func TestTapHostFromConfigPrefersTheBoxsOwnName(t *testing.T) {
	const (
		tapOwn = "oc-tap-home.buyallmemes.com"
		tapOld = "oc-tap.buyallmemes.com"
		uiOwn  = "oc-home.buyallmemes.com"
		uiOld  = "oc.buyallmemes.com"
	)
	orders := []struct {
		name string
		raw  string
	}{
		{
			name: "the old names first",
			raw: "ingress:\n" +
				"  - hostname: " + tapOld + "\n    service: http://127.0.0.1:49400\n" +
				"  - hostname: " + uiOld + "\n    service: http://127.0.0.1:49374\n" +
				"  - hostname: " + tapOwn + "\n    service: http://127.0.0.1:49400\n" +
				"  - hostname: " + uiOwn + "\n    service: http://127.0.0.1:49374\n",
		},
		{
			name: "the box's own names first",
			raw: "ingress:\n" +
				"  - hostname: " + tapOwn + "\n    service: http://127.0.0.1:49400\n" +
				"  - hostname: " + uiOwn + "\n    service: http://127.0.0.1:49374\n" +
				"  - hostname: " + tapOld + "\n    service: http://127.0.0.1:49400\n" +
				"  - hostname: " + uiOld + "\n    service: http://127.0.0.1:49374\n",
		},
	}
	for _, o := range orders {
		t.Run(o.name, func(t *testing.T) {
			tapHost, uiHost, err := onboard.TapHostFromConfig(plantIngressConfig(t, o.raw), "home")
			if err != nil {
				t.Fatalf("read the config: %v", err)
			}
			if tapHost != tapOwn {
				t.Fatalf("tap host = %q, want %q", tapHost, tapOwn)
			}
			if uiHost != uiOwn {
				t.Fatalf("ui host = %q, want %q", uiHost, uiOwn)
			}
		})
	}
}

// A box that never followed the convention still works: the first rule
// of each kind is its host.
func TestTapHostFromConfigFallsBackToTheFirstRule(t *testing.T) {
	raw := "ingress:\n" +
		"  - hostname: oc-tap.buyallmemes.com\n    service: http://127.0.0.1:49400\n" +
		"  - hostname: oc.buyallmemes.com\n    service: http://127.0.0.1:49374\n"
	tapHost, uiHost, err := onboard.TapHostFromConfig(plantIngressConfig(t, raw), "home")
	if err != nil {
		t.Fatalf("read the config: %v", err)
	}
	if tapHost != "oc-tap.buyallmemes.com" {
		t.Fatalf("tap host = %q, want the first daemon rule", tapHost)
	}
	if uiHost != "oc.buyallmemes.com" {
		t.Fatalf("ui host = %q, want the first editor rule", uiHost)
	}
}

// The convention names a box, not a domain: a box that serves its own
// name on another domain keeps it.
func TestTapHostFromConfigMatchesTheNameNotTheDomain(t *testing.T) {
	raw := "ingress:\n" +
		"  - hostname: oc-tap.example.org\n    service: http://127.0.0.1:49400\n" +
		"  - hostname: oc.example.org\n    service: http://127.0.0.1:49374\n" +
		"  - hostname: oc-tap-home.example.org\n    service: http://127.0.0.1:49400\n" +
		"  - hostname: oc-home.example.org\n    service: http://127.0.0.1:49374\n"
	tapHost, uiHost, err := onboard.TapHostFromConfig(plantIngressConfig(t, raw), "home")
	if err != nil {
		t.Fatalf("read the config: %v", err)
	}
	if tapHost != "oc-tap-home.example.org" {
		t.Fatalf("tap host = %q, want the box's own name", tapHost)
	}
	if uiHost != "oc-home.example.org" {
		t.Fatalf("ui host = %q, want the box's own name", uiHost)
	}
}

// A config that serves no daemon rule cannot name the tap host.
func TestTapHostFromConfigRefusesAConfigWithoutADaemonRule(t *testing.T) {
	raw := "ingress:\n" +
		"  - hostname: oc-home.buyallmemes.com\n    service: http://127.0.0.1:49374\n"
	if _, _, err := onboard.TapHostFromConfig(plantIngressConfig(t, raw), "home"); err == nil {
		t.Fatal("a config without a daemon rule cannot name the tap host")
	}
}
