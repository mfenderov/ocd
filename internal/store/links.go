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
	At     int64
	Actor  string
	Action string
	Device string
	IP     string
	Result string
	UA     string
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

func (s *Store) Audit(actor, action, device, ip, result string) {
	s.AuditUA(actor, action, device, ip, result, "")
}

func truncateUA(ua string) string {
	if len(ua) > 300 {
		return ua[:300]
	}
	return ua
}

func (s *Store) AuditUA(actor, action, device, ip, result, ua string) {
	_, _ = s.db.Exec(`INSERT INTO audit(at, actor, action, device, ip, result, ua) VALUES(strftime('%s','now'),?,?,?,?,?,?)`, actor, action, device, ip, result, truncateUA(ua))
	go s.prune()
}

func (s *Store) prune() {
	_, _ = s.db.Exec(`DELETE FROM audit WHERE at<strftime('%s','now')-?`, int64((90*24*time.Hour).Seconds()))
	_, _ = s.db.Exec(`DELETE FROM link_tokens WHERE created_at<strftime('%s','now')-?`, int64((24*time.Hour).Seconds()))
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
