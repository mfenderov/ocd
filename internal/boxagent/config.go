package boxagent

import "os"

// BrainConfig is how this box reaches the brain: where the brain is,
// which box this is, and the bearer that proves it.
type BrainConfig struct {
	// BrainURL is the brain's origin. It canonically ends in
	// /api/heartbeat; the push clients tolerate a bare origin too.
	BrainURL string
	// BoxID identifies this box to the brain.
	BoxID string
	// Token authenticates the box: the heartbeat bearer.
	Token string
}

// Ready reports whether the box can talk to the brain: all three values
// must be there.
func (c BrainConfig) Ready() bool {
	return c.BrainURL != "" && c.BoxID != "" && c.Token != ""
}

// BrainConfigFromEnv reads the brain's configuration from the
// environment: OCD_WORKER_URL, OCD_BOX_ID and OCD_HEARTBEAT_TOKEN.
func BrainConfigFromEnv() BrainConfig {
	return BrainConfig{
		BrainURL: os.Getenv("OCD_WORKER_URL"),
		BoxID:    os.Getenv("OCD_BOX_ID"),
		Token:    os.Getenv("OCD_HEARTBEAT_TOKEN"),
	}
}
