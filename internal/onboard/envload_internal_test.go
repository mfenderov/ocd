package onboard

import "testing"

// The keys the env file holds: letters, an underscore, and digits after
// the first character.
func TestValidEnvKey(t *testing.T) {
	for _, ok := range []string{"OCD_BOX_ID", "A", "_", "A1", "OCD_DB_PATH", "a0"} {
		if !validEnvKey(ok) {
			t.Fatalf("want %q valid", ok)
		}
	}
	for _, bad := range []string{"", "1OCD", "OCD-BOX", "OCD BOX", "OCD.BOX", "OCD$"} {
		if validEnvKey(bad) {
			t.Fatalf("want %q rejected", bad)
		}
	}
}
