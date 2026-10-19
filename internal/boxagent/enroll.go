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
}

type enrollResponse struct {
	Status string `json:"status"`
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
// admin_token?} to the Worker and returns the status ("enrolled" fast path
// when the box is known, "pending" awaiting owner approval). The enroll
// token travels in the body: first contact has no bearer credentials yet.
// Any non-200 is an error, no local retry.
func EnrollBox(ctx context.Context, client *http.Client, workerURL, id, hostname, enrollToken, adminToken string) (string, error) {
	if strings.TrimSpace(id) == "" {
		return "", errors.New("boxagent: box id is empty; refusing to enroll without an id")
	}
	if strings.TrimSpace(hostname) == "" {
		return "", errors.New("boxagent: hostname is empty; refusing to enroll without a hostname")
	}
	if enrollToken == "" {
		return "", errors.New("boxagent: enroll token is empty; refusing to enroll without a token")
	}
	payload, err := json.Marshal(enrollRequest{
		ID:          id,
		Hostname:    hostname,
		EnrollToken: enrollToken,
		AdminToken:  adminToken,
	})
	if err != nil {
		return "", fmt.Errorf("boxagent: encode enroll: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, enrollURL(workerURL), bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("boxagent: build enroll request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, enrollTimeout)
		defer cancel()
		req = req.WithContext(ctx)
	}
	resp, err := withTimeout(client).Do(req)
	if err != nil {
		return "", fmt.Errorf("boxagent: post enroll: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("boxagent: enroll worker replied %d %s", resp.StatusCode, http.StatusText(resp.StatusCode))
	}
	var out enrollResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("boxagent: decode enroll: %w", err)
	}
	if out.Status == "" {
		return "", fmt.Errorf("boxagent: enroll worker omitted status")
	}
	return out.Status, nil
}
