package onboard_test

import (
	"testing"

	"github.com/mfenderov/ocd/internal/onboard"
)

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
