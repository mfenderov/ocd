// Package fleet is the `ocd fleet` console client for the fleet Worker API.
//
// Auth reads the CLI token from OCD_FLEET_TOKEN only. Keychain storage is
// explicitly out of scope: env keeps the token out of process args and shell
// history, and this client never logs it. The Worker origin comes from
// OCD_WORKER_URL, shared with box heartbeats. Box ids never reach a shell:
// they are URL-escaped path segments only.
package fleet

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// requestTimeout bounds one console call. Revoke-all fans out box by box
// server-side, so the budget covers a small fleet, not one box.
const requestTimeout = 30 * time.Second

// Client talks to the fleet Worker API with a fixed bearer token.
type Client struct {
	base string
	// token is the OCD_FLEET_TOKEN value. It travels in exactly one place
	// (the Authorization header) and is never logged or echoed in errors.
	token string
	http  *http.Client
}

// NewClientFromEnv builds a Client from OCD_WORKER_URL + OCD_FLEET_TOKEN.
// Keychain integration is explicitly out of scope (see package doc).
// The Worker URL accepts both the bare origin and the heartbeat endpoint:
// a trailing /api/heartbeat (the heartbeat sender's canonical form) is
// stripped so fleet paths resolve under the origin either way.
func NewClientFromEnv() (*Client, error) {
	base := strings.TrimSuffix(os.Getenv("OCD_WORKER_URL"), "/")
	base = strings.TrimSuffix(base, "/api/heartbeat")
	if base == "" {
		return nil, fmt.Errorf("fleet: OCD_WORKER_URL is empty; point it at the fleet Worker origin")
	}
	token := os.Getenv("OCD_FLEET_TOKEN")
	if token == "" {
		return nil, fmt.Errorf("fleet: OCD_FLEET_TOKEN is empty")
	}
	return &Client{base: base, token: token, http: &http.Client{Timeout: requestTimeout}}, nil
}

// Backend is the public per-box shape served by GET /api/backends.
// Secret material never appears here by server contract.
type Backend struct {
	ID         string `json:"id"`
	Hostname   string `json:"hostname"`
	Epoch      int    `json:"epoch"`
	LastSeq    int64  `json:"last_seq"`
	LastTS     int64  `json:"last_ts"`
	LastSeen   int64  `json:"last_seen"`
	Enrolled   int    `json:"enrolled"`
	Tombstoned bool   `json:"tombstoned"`
}

// RevokeResult is the per-box outcome of revoke / revoke-all.
type RevokeResult struct {
	ID        string `json:"id"`
	Status    string `json:"status"`
	Epoch     int    `json:"epoch,omitempty"`
	BoxStatus int    `json:"box_status,omitempty"`
	Detail    string `json:"detail,omitempty"`
}

// AuditRow is one merged audit entry: either an event row or a last-synced
// error marker. Exactly one of the event fields / Error is populated.
type AuditRow struct {
	Box      string `json:"box"`
	At       int64  `json:"at"`
	Actor    string `json:"actor,omitempty"`
	Action   string `json:"action,omitempty"`
	Device   string `json:"device,omitempty"`
	IP       string `json:"ip,omitempty"`
	Result   string `json:"result,omitempty"`
	UA       string `json:"ua,omitempty"`
	Tainted  bool   `json:"tainted"`
	Error    string `json:"error,omitempty"`
	Detail   string `json:"detail,omitempty"`
	LastSeen int64  `json:"last_seen,omitempty"`
}

// IsError reports whether the row is a last-synced marker, not an event.
func (r AuditRow) IsError() bool { return r.Error != "" }

// APIError is a non-200 from the Worker. It carries the status and the
// server's snake_case code, never the token.
type APIError struct {
	Status int
	Code   string
}

func (e *APIError) Error() string {
	if e.Status == http.StatusUnauthorized {
		return "fleet: unauthorized (check OCD_FLEET_TOKEN)"
	}
	return fmt.Sprintf("fleet: worker replied %d (%s)", e.Status, e.Code)
}

func (c *Client) do(ctx context.Context, method, path string, query url.Values, body any, extra map[string]string) (*http.Response, error) {
	var r io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("fleet: encode request: %w", err)
		}
		r = bytes.NewReader(raw)
	}
	target := c.base + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, target, r)
	if err != nil {
		return nil, fmt.Errorf("fleet: build request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fleet: worker unreachable: %w", err)
	}
	return resp, nil
}

// decodeError drains a non-200 body into an *APIError, preferring the
// server's {"error": code} shape and falling back to the HTTP status text.
func decodeError(resp *http.Response) error {
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	var coded struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(raw, &coded) == nil && coded.Error != "" {
		return &APIError{Status: resp.StatusCode, Code: coded.Error}
	}
	var res RevokeResult
	if json.Unmarshal(raw, &res) == nil && res.Status != "" {
		return &APIError{Status: resp.StatusCode, Code: res.Status}
	}
	return &APIError{Status: resp.StatusCode, Code: http.StatusText(resp.StatusCode)}
}

func checkBoxID(boxID string) (string, error) {
	if strings.TrimSpace(boxID) == "" {
		return "", fmt.Errorf("fleet: box id is empty")
	}
	return url.PathEscape(boxID), nil
}

// OfflineAfter is how long a box may go without a heartbeat before the
// console calls it offline. The Worker exposes no online flag (deferred
// Plan 2 decision), so the CLI infers it: three missed beats at the 30s
// fleet heartbeat default (internal/cli/serve.go).
const OfflineAfter = 90 * time.Second

// BoxState classifies one backend for display: tombstoned (server-side
// pending-revoke block) wins over staleness, then a box quieter than
// OfflineAfter reads offline, otherwise ok. Pure in (box, now) so the
// boundary is unit-testable without clock flakiness.
func BoxState(b Backend, now time.Time) string {
	if b.Tombstoned {
		return "tombstoned"
	}
	if now.Unix()-b.LastSeen > int64(OfflineAfter.Seconds()) {
		return "offline"
	}
	return "ok"
}

// syncAge renders a last_seen timestamp as a short last-synced age.
func syncAge(lastSeen, now int64) string {
	d := now - lastSeen
	if d < 0 {
		d = 0
	}
	switch {
	case d < 60:
		return fmt.Sprintf("%ds ago", d)
	case d < 3600:
		return fmt.Sprintf("%dm ago", d/60)
	default:
		return fmt.Sprintf("%dh ago", d/3600)
	}
}

// Backends lists every enrolled box with its tombstone flag.
func (c *Client) Backends(ctx context.Context) ([]Backend, error) {
	resp, err := c.do(ctx, http.MethodGet, "/api/backends", nil, nil, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, decodeError(resp)
	}
	var out []Backend
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("fleet: decode backends: %w", err)
	}
	return out, nil
}

// newIDKey mints one idempotency key per console link request so a CLI
// retry reuses the box-side mint instead of rotating twice.
func newIDKey() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("cli-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}

// Link mints a tap URL for one box. The Worker serves it as tap-URL text.
func (c *Client) Link(ctx context.Context, boxID string) (string, error) {
	esc, err := checkBoxID(boxID)
	if err != nil {
		return "", err
	}
	resp, err := c.do(ctx, http.MethodPost, "/api/backends/"+esc+"/link", nil, nil,
		map[string]string{"Idempotency-Key": newIDKey()})
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", decodeError(resp)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return "", fmt.Errorf("fleet: read link: %w", err)
	}
	return strings.TrimSpace(string(raw)), nil
}

// Revoke revokes one box, always with the server-side confirm body.
func (c *Client) Revoke(ctx context.Context, boxID string) (RevokeResult, error) {
	var zero RevokeResult
	esc, err := checkBoxID(boxID)
	if err != nil {
		return zero, err
	}
	resp, err := c.do(ctx, http.MethodPost, "/api/backends/"+esc+"/revoke", nil,
		map[string]any{"confirm": true}, nil)
	if err != nil {
		return zero, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return zero, decodeError(resp)
	}
	var out RevokeResult
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return zero, fmt.Errorf("fleet: decode revoke: %w", err)
	}
	return out, nil
}

// RevokeAll revokes every box, always with the server-side confirm body.
func (c *Client) RevokeAll(ctx context.Context) ([]RevokeResult, error) {
	resp, err := c.do(ctx, http.MethodPost, "/api/revoke-all", nil,
		map[string]any{"confirm": true}, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, decodeError(resp)
	}
	var out struct {
		Results []RevokeResult `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("fleet: decode revoke-all: %w", err)
	}
	return out.Results, nil
}

// clampN mirrors the box page contract: default 50, cap 200, garbage 50.
func clampN(n int) int {
	if n <= 0 {
		return 50
	}
	return min(n, 200)
}

// Audit merges recent rows across boxes (or one box when boxID is set).
func (c *Client) Audit(ctx context.Context, boxID string, n int) ([]AuditRow, error) {
	q := url.Values{}
	if strings.TrimSpace(boxID) != "" {
		q.Set("box", strings.TrimSpace(boxID))
	}
	q.Set("n", fmt.Sprint(clampN(n)))
	resp, err := c.do(ctx, http.MethodGet, "/api/audit", q, nil, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, decodeError(resp)
	}
	var out struct {
		Rows []AuditRow `json:"rows"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("fleet: decode audit: %w", err)
	}
	return out.Rows, nil
}
