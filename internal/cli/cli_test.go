package cli_test

import (
	"strings"
	"testing"

	"github.com/mfenderov/ocd/internal/cli"
)

func TestRootHasServe(t *testing.T) {
	root := cli.Root()
	found := false
	for _, c := range root.Commands() {
		if c.Name() == "serve" {
			found = true
		}
	}
	if !found {
		t.Fatal("want serve subcommand")
	}
}

func TestRootHasMintDevicesStatus(t *testing.T) {
	root := cli.Root()
	want := map[string]bool{"mint": false, "devices": false, "status": false}
	for _, c := range root.Commands() {
		if _, ok := want[c.Name()]; ok {
			want[c.Name()] = true
		}
	}
	for name, ok := range want {
		if !ok {
			t.Fatalf("want %s subcommand", name)
		}
	}
}

func TestServeRefusesWithoutToken(t *testing.T) {
	t.Setenv("OCD_TG_TOKEN", "")
	t.Setenv("OCD_OWNER_ID", "")
	var sb strings.Builder
	if err := cli.RunServe(&sb); err == nil {
		t.Fatal("want refusal without token")
	}
}
