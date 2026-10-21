package boxagent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// enrollTimeout bounds a single enrollment POST.
const enrollTimeout = 15 * time.Second

type enrollRequest struct {
	ID          string `json:"id"`
	Hostname    string `json:"hostname"`
	EnrollToken string `json:"enroll_token"`
	AdminToken  string `json:"admin_token,omitempty"`
	// TunnelID is the box's cloudflared tunnel id, empty when the box
	// has no tunnel.
	TunnelID string `json:"tunnel_id,omitempty"`
	// Quiet suppresses the Worker-side approve/deny ping. Used by the
	// code flow: the token message is the only message the owner needs.
	Quiet bool `json:"quiet,omitempty"`
}

// EnrollOptions tunes one enrollment request.
type EnrollOptions struct {
	// Quiet suppresses the Worker's approve/deny ping.
	Quiet bool
	// Bearer authenticates the request as owner-issued. A CLI token with
	// the "enroll" scope marks the pending row trusted, which is what
	// lets the box claim it by typing the code (no approve tap). Without
	// it the pending row needs the approve tap.
	Bearer string
	// TunnelID is the box's cloudflared tunnel id, empty when the box
	// has no tunnel. The field is sent so the brain can own the box's
	// DNS once it reads it.
	TunnelID string
}

// EnrollOutcome is what the brain said about an enrollment. It is the
// decoded answer, so the box reads one shape.
type EnrollOutcome struct {
	// Status is "enrolled" (the box is bound) or "pending" (it waits
	// for the owner's approval).
	Status string `json:"status"`
	// Trusted reports whether the box may be claimed by typing the code.
	// False means the request lacked the "enroll" scope, so the box needs
	// the approve tap instead.
	Trusted bool `json:"trusted"`
	// DNS is what the brain did about the box's two CNAMEs after the
	// enrollment committed: "ok", "skipped: <reason>" or
	// "failed: <reason>". Empty on a pending enrollment — there is no
	// box yet, so there is no DNS to report.
	DNS string `json:"dns"`
}

// enrollURL tolerates the heartbeat-suffixed origin too: OCD_WORKER_URL
// canonically ends in /api/heartbeat, so strip that before resolving the
// enroll endpoint (same tolerance as the fleet client).
func enrollURL(base string) string {
	trimmed := strings.TrimSuffix(base, "/")
	trimmed = strings.TrimSuffix(trimmed, "/api/heartbeat")
	if strings.HasSuffix(trimmed, "/api/enroll") {
		return trimmed
	}
	return trimmed + "/api/enroll"
}

// EnrollBox posts an enrollment request {id, hostname, enroll_token,
// admin_token?} to the Worker and returns what the Worker said: the
// status ("enrolled" fast path when the box is known, "pending" awaiting
// owner approval), whether the box may be claimed by typing the code,
// and what the brain did about the box's DNS. The enroll token travels
// in the body: first contact has no bearer credentials yet. Any non-200
// is an error, no local retry.
func EnrollBox(ctx context.Context, client *http.Client, workerURL, id, hostname,
	enrollToken, adminToken string, opts EnrollOptions) (EnrollOutcome, error) {
	if err := checkEnrollInput(id, hostname, enrollToken); err != nil {
		return EnrollOutcome{}, err
	}
	ctx, cancel := enrollContext(ctx)
	defer cancel()
	req, err := newEnrollRequest(ctx, workerURL, id, hostname, enrollToken, adminToken, opts)
	if err != nil {
		return EnrollOutcome{}, err
	}
	resp, err := withTimeout(client).Do(req)
	if err != nil {
		return EnrollOutcome{}, fmt.Errorf("boxagent: post enroll: %w", err)
	}
	defer resp.Body.Close()
	return readEnrollOutcome(resp)
}

// checkEnrollInput refuses an enrolment without the identity it needs:
// the brain binds the box to what the request carries.
func checkEnrollInput(id, hostname, enrollToken string) error {
	if strings.TrimSpace(id) == "" {
		return errors.New("boxagent: box id is empty; refusing to enroll without an id")
	}
	if strings.TrimSpace(hostname) == "" {
		return errors.New("boxagent: hostname is empty; refusing to enroll without a hostname")
	}
	if enrollToken == "" {
		return errors.New("boxagent: enroll token is empty; refusing to enroll without a token")
	}
	return nil
}

// enrollContext bounds the enrolment: a request without a deadline of
// its own gets the enrolment timeout.
func enrollContext(ctx context.Context) (context.Context, context.CancelFunc) {
	if _, ok := ctx.Deadline(); ok {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, enrollTimeout)
}

// newEnrollRequest is the request the enrolment sends.
func newEnrollRequest(ctx context.Context, workerURL, id, hostname,
	enrollToken, adminToken string, opts EnrollOptions) (*http.Request, error) {
	payload, err := json.Marshal(enrollRequest{
		ID:          id,
		Hostname:    hostname,
		EnrollToken: enrollToken,
		AdminToken:  adminToken,
		TunnelID:    opts.TunnelID,
		Quiet:       opts.Quiet,
	})
	if err != nil {
		return nil, fmt.Errorf("boxagent: encode enroll: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, enrollURL(workerURL), bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("boxagent: build enroll request: %w", err)
	}
	setEnrollHeaders(req, opts)
	return req, nil
}

// setEnrollHeaders says what the request is: a JSON body, and the
// bearer when the caller has one.
func setEnrollHeaders(req *http.Request, opts EnrollOptions) {
	req.Header.Set("Content-Type", "application/json")
	if opts.Bearer != "" {
		req.Header.Set("Authorization", "Bearer "+opts.Bearer)
	}
}

// readEnrollOutcome is what the worker answered: the outcome, or the
// error it replied with.
func readEnrollOutcome(resp *http.Response) (EnrollOutcome, error) {
	if resp.StatusCode != http.StatusOK {
		return EnrollOutcome{}, fmt.Errorf("boxagent: enroll worker replied %d %s",
			resp.StatusCode, http.StatusText(resp.StatusCode))
	}
	var out EnrollOutcome
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return EnrollOutcome{}, fmt.Errorf("boxagent: decode enroll: %w", err)
	}
	if out.Status == "" {
		return EnrollOutcome{}, errors.New("boxagent: enroll worker omitted status")
	}
	return out, nil
}
