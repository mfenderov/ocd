package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"strings"
	"time"
)

const linkTTL = 10 * time.Minute

type AuditRow struct {
	At     int64  `json:"at"`
	Actor  string `json:"actor"`
	Action string `json:"action"`
	Device string `json:"device"`
	IP     string `json:"ip"`
	Result string `json:"result"`
	UA     string `json:"ua"`
}

func (s *Store) migrateLinks() error {
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS link_tokens(token TEXT PRIMARY KEY, device TEXT, via TEXT, created_at INTEGER, used_at INTEGER);
CREATE TABLE IF NOT EXISTS audit(at INTEGER, actor TEXT, action TEXT, device TEXT, ip TEXT, result TEXT);`)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(`ALTER TABLE audit ADD COLUMN ua TEXT DEFAULT ''`); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
		return err
	}
	return nil
}

func newToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func (s *Store) IssueLink(device, via string) (string, error) {
	tok, err := newToken()
	if err != nil {
		return "", err
	}
	_, err = s.db.Exec(`INSERT INTO link_tokens(token, device, via, created_at, used_at) VALUES(?,?,?,strftime('%s','now'),NULL)`, tok, device, via)
	return tok, err
}

// ConsumeLink atomically claims a token once. Reports device and true only
// on the first tap inside the TTL window.
func (s *Store) ConsumeLink(tok string) (string, bool) {
	var device string
	err := s.db.QueryRow(`SELECT device FROM link_tokens WHERE token=? AND used_at IS NULL AND created_at>=strftime('%s','now')-?`, tok, int64(linkTTL.Seconds())).Scan(&device)
	if err != nil {
		return "", false
	}
	res, err := s.db.Exec(`UPDATE link_tokens SET used_at=strftime('%s','now') WHERE token=? AND used_at IS NULL`, tok)
	if err != nil {
		return "", false
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		return "", false
	}
	return device, true
}

// DeleteLinkTokens removes the given tokens from the store. The caller
// uses it once the brain has been told a link died: a token past its TTL
// can no longer be claimed, so nothing else needs the row, and keeping
// it would make every sweep report the same dead link again.
func (s *Store) DeleteLinkTokens(tokens []string) error {
	for _, tok := range tokens {
		if _, err := s.db.Exec(`DELETE FROM link_tokens WHERE token=?`, tok); err != nil {
			return err
		}
	}
	return nil
}

// ExpiredLinkTokens returns the tokens that were never used and are past
// their TTL: the brain has to learn that its links died. At most limit
// tokens, oldest first. A token that was used is spent, not dead, so it
// is never reported.
func (s *Store) ExpiredLinkTokens(limit int) ([]string, error) {
	if limit <= 0 {
		return nil, nil
	}
	rows, err := s.db.Query(`SELECT token FROM link_tokens WHERE used_at IS NULL AND created_at<strftime('%s','now')-? ORDER BY created_at LIMIT ?`, int64(linkTTL.Seconds()), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var tok string
		if err := rows.Scan(&tok); err != nil {
			return nil, err
		}
		out = append(out, tok)
	}
	return out, rows.Err()
}

func (s *Store) Audit(actor, action, device, ip, result string) {
	s.AuditUA(actor, action, device, ip, result, "")
}

func truncateUA(ua string) string {
	if len(ua) > 300 {
		return ua[:300]
	}
	return ua
}

func (s *Store) AuditUA(actor, action, device, ip, result, ua string) int64 {
	res, err := s.db.Exec(`INSERT INTO audit(at, actor, action, device, ip, result, ua) VALUES(strftime('%s','now'),?,?,?,?,?,?)`, actor, action, device, ip, result, truncateUA(ua))
	if err != nil {
		// A closed store must not take the caller down: a background writer
		// can outlive the daemon's shutdown, and a panic in a goroutine
		// kills the whole process.
		return 0
	}
	go s.prune()
	id, _ := res.LastInsertId()
	return id
}

func (s *Store) SetResultExtra(id int64, extra string) {
	if extra == "" {
		return
	}
	_, _ = s.db.Exec(`UPDATE audit SET result=result||? WHERE rowid=?`, " · "+extra, id)
}

func (s *Store) prune() {
	_, _ = s.db.Exec(`DELETE FROM audit WHERE at<strftime('%s','now')-?`, int64((90 * 24 * time.Hour).Seconds()))
	_, _ = s.db.Exec(`DELETE FROM link_tokens WHERE created_at<strftime('%s','now')-?`, int64((24 * time.Hour).Seconds()))
}

func (s *Store) RecentAudit(n int) []AuditRow {
	rows, err := s.db.Query(`SELECT at, actor, action, device, ip, result, ua FROM audit ORDER BY at DESC LIMIT ?`, n)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []AuditRow
	for rows.Next() {
		var r AuditRow
		var ua sql.NullString
		if err := rows.Scan(&r.At, &r.Actor, &r.Action, &r.Device, &r.IP, &r.Result, &ua); err == nil {
			r.UA = ua.String
			out = append(out, r)
		}
	}
	return out
}
