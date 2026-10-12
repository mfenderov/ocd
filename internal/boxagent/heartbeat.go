// Package boxagent sends box heartbeats to the fleet Worker.
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

	"github.com/mfenderov/ocd/internal/store"
)

// heartbeatTimeout bounds a single heartbeat POST.
const heartbeatTimeout = 10 * time.Second

type heartbeatRequest struct {
	ID          string `json:"id"`
	Seq         int64  `json:"seq"`
	BoxNow      int64  `json:"box_now"`
	Epoch       int    `json:"epoch"`
	Version     string `json:"version"`
	EnrollToken string `json:"enroll_token,omitempty"`
}

type heartbeatResponse struct {
	Enrolled bool `json:"enrolled"`
}

// SendOnce POSTs one heartbeat {id, seq, box_now, epoch, version} to the
// Worker with Authorization: Bearer <token>. enrollToken is included until
// the Worker replies {"enrolled": true}; the caller drops it afterwards and
// retries failed sends on its ticker. Any non-200 is an error, no local retry.
func SendOnce(st *store.Store, client *http.Client, workerURL, boxID, token, enrollToken, version string) (bool, error) {
	if boxID == "" {
		return false, errors.New("boxagent: OCD_BOX_ID is empty; refusing to heartbeat without an id")
	}
	payload, err := heartbeatBody(st, boxID, enrollToken, version)
	if err != nil {
		return false, err
	}
	return postHeartbeat(withTimeout(client), workerURL, token, payload)
}

func heartbeatBody(st *store.Store, boxID, enrollToken, version string) ([]byte, error) {
	payload, err := json.Marshal(heartbeatRequest{
		ID:          boxID,
		Seq:         st.NextHeartbeatSeq(),
		BoxNow:      time.Now().Unix(),
		Epoch:       st.PasswordEpoch(),
		Version:     version,
		EnrollToken: enrollToken,
	})
	if err != nil {
		return nil, fmt.Errorf("boxagent: encode heartbeat: %w", err)
	}
	return payload, nil
}

func withTimeout(client *http.Client) *http.Client {
	out := &http.Client{Timeout: heartbeatTimeout}
	if client != nil {
		*out = *client
		if out.Timeout == 0 {
			out.Timeout = heartbeatTimeout
		}
	}
	return out
}

// heartbeatURL tolerates a bare Worker origin: the endpoint path is
// appended unless already present, so OCD_WORKER_URL works with or
// without the /api/heartbeat suffix.
func heartbeatURL(base string) string {
	trimmed := strings.TrimSuffix(base, "/")
	if strings.HasSuffix(trimmed, "/api/heartbeat") {
		return trimmed
	}
	return trimmed + "/api/heartbeat"
}

func postHeartbeat(client *http.Client, workerURL, token string, payload []byte) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), heartbeatTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, heartbeatURL(workerURL), bytes.NewReader(payload))
	if err != nil {
		return false, fmt.Errorf("boxagent: build heartbeat request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := client.Do(req)
	if err != nil {
		return false, fmt.Errorf("boxagent: post heartbeat: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("boxagent: heartbeat worker replied %s", resp.Status)
	}
	var out heartbeatResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return false, fmt.Errorf("boxagent: decode heartbeat reply: %w", err)
	}
	return out.Enrolled, nil
}
