package boxagent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// Event is one thing a box tells the brain.
type Event struct {
	Type   string `json:"type"`
	Token  string `json:"token,omitempty"`
	IP     string `json:"ip,omitempty"`
	UA     string `json:"ua,omitempty"`
	At     int64  `json:"at,omitempty"`
	Actor  string `json:"actor,omitempty"`
	Action string `json:"action,omitempty"`
	Device string `json:"device,omitempty"`
	Result string `json:"result,omitempty"`
}

// eventsRequest is the body of POST /api/events: the box id the events
// belong to and the events themselves.
type eventsRequest struct {
	ID     string  `json:"id"`
	Events []Event `json:"events"`
}

// eventsURL resolves the brain's event endpoint. It tolerates the
// heartbeat-suffixed origin: OCD_WORKER_URL canonically ends in
// /api/heartbeat, so that suffix is stripped before the event path is
// appended (the same tolerance as the enrolment URL).
func eventsURL(base string) string {
	trimmed := strings.TrimSuffix(base, "/")
	trimmed = strings.TrimSuffix(trimmed, "/api/heartbeat")
	return trimmed + "/api/events"
}

// PushEvents sends the box's events to the brain: POST <brainURL>/api/events
// with Authorization: Bearer <token> and the body {"id": "<boxID>",
// "events": [...]}. It returns an error the caller is free to ignore: the
// push is best effort.
//
// The caller's context bounds the request. The tap path gives it a short
// deadline, so a slow brain never holds a tap.
func PushEvents(ctx context.Context, client *http.Client, brainURL, boxID, token string, events []Event) error {
	if strings.TrimSpace(boxID) == "" {
		return errors.New("boxagent: box id is empty; refusing to push events without an id")
	}
	if token == "" {
		return errors.New("boxagent: token is empty; refusing to push events without a token")
	}
	if len(events) == 0 {
		return nil
	}
	payload, err := json.Marshal(eventsRequest{ID: boxID, Events: events})
	if err != nil {
		return fmt.Errorf("boxagent: encode events: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, eventsURL(brainURL), bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("boxagent: build events request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := withTimeout(client).Do(req)
	if err != nil {
		return fmt.Errorf("boxagent: post events: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("boxagent: brain replied %s", resp.Status)
	}
	return nil
}
