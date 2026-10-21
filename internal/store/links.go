package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

const linkTTL = 10 * time.Minute

// brainLinkVia marks the links the brain minted through the box's admin
// mint handler. The Go bot mints its own links (via "telegram") and edits
// their Telegram messages itself, so the brain's sweep leaves those alone.
const brainLinkVia = "admin"

type AuditRow struct {
	// RowID is the row's place in the audit table. RecentAuditSince
	// fills it: the sweep's watermark is the rowid of the last row it
	// reported. It stays out of the JSON: the box's own API answers with
	// the rows as they are, rowid included nowhere.
	RowID  int64  `json:"-"`
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

// DeleteLinkTokens removes the given brain links from the store. The
// caller uses it once the brain has been told a link died: a token past
// its TTL can no longer be claimed, so nothing else needs the row, and
// keeping it would make every sweep report the same dead link again.
//
// Only the brain's own links are removed. A Go bot link passed in by
// mistake is left alone: that link still has an expired-link edit to
// make, and the brain would never make it.
func (s *Store) DeleteLinkTokens(tokens []string) error {
	for _, tok := range tokens {
		if _, err := s.db.Exec(`DELETE FROM link_tokens WHERE token=? AND via=?`, tok, brainLinkVia); err != nil {
			return err
		}
	}
	return nil
}

// ExpiredLinkTokens returns the tokens that were never used and are past
// their TTL: the brain has to learn that its links died. At most limit
// tokens, oldest first. A token that was used is spent, not dead, so it
// is never reported.
//
// Only the brain's own links are reported. The Go bot's links are its
// own business: its sweeper still has to edit their Telegram messages,
// and the brain would ignore them anyway.
func (s *Store) ExpiredLinkTokens(limit int) ([]string, error) {
	if limit <= 0 {
		return nil, nil
	}
	rows, err := s.db.Query(`SELECT token FROM link_tokens WHERE via=? AND used_at IS NULL AND created_at<strftime('%s','now')-? ORDER BY created_at LIMIT ?`, brainLinkVia, int64(linkTTL.Seconds()), limit)
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

// auditBatch is how many audit rows one read returns. The sweep pushes
// them in one batch; the rows past the batch wait for the next sweep.
const auditBatch = 100

// RecentAuditSince returns the audit rows written after the given rowid,
// oldest first, at most auditBatch of them. The rowid is the sweep's
// watermark: the rows the brain has not seen yet, so a restart does not
// re-send the whole history.
func (s *Store) RecentAuditSince(rowid int64) ([]AuditRow, error) {
	rows, err := s.db.Query(`SELECT rowid, at, actor, action, device, ip, result, ua FROM audit WHERE rowid > ? ORDER BY rowid LIMIT ?`, rowid, auditBatch)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AuditRow
	for rows.Next() {
		var r AuditRow
		var ua sql.NullString
		if err := rows.Scan(&r.RowID, &r.At, &r.Actor, &r.Action, &r.Device, &r.IP, &r.Result, &ua); err != nil {
			return nil, err
		}
		r.UA = ua.String
		out = append(out, r)
	}
	return out, rows.Err()
}

// AuditWatermark returns the rowid of the last audit row the box
// reported to the brain, 0 when it never reported one.
//
// The read can fail, and a failure is not "nothing reported yet": the
// caller must not read it as 0, or it re-offers rows the brain already
// has and sends the watermark backwards.
func (s *Store) AuditWatermark() (int64, error) {
	var v int64
	err := s.db.QueryRow(`SELECT v FROM meta WHERE k='audit_watermark'`).Scan(&v)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	return v, nil
}

// AuditAnchor is the content of the row the watermark names: the row's
// own (at, action).
//
// A rowid is a position, not an identity. The trail's rowids start over
// when the trail is reset, so the same rowid can name a different row
// after the reset — and the rows in between are then lost for good. The
// anchor is the content, and the content is what tells the two apart.
//
// (at, action) is the identity because it is the brain's identity: the
// brain keys its history on (box, at, action, token) and the box's rows
// carry no token.
type AuditAnchor struct {
	At     int64
	Action string
}

// WatermarkAnchor returns the anchor stored next to the audit
// watermark: the content of the row the watermark names. False when no
// anchor is stored — a database written before the anchor existed.
func (s *Store) WatermarkAnchor() (AuditAnchor, bool, error) {
	var anchor AuditAnchor
	err := s.db.QueryRow(`SELECT v FROM meta WHERE k='audit_watermark_at'`).Scan(&anchor.At)
	if errors.Is(err, sql.ErrNoRows) {
		return AuditAnchor{}, false, nil
	}
	if err != nil {
		return AuditAnchor{}, false, err
	}
	// The action is text in an integer column: SQLite keeps it as text
	// unless it reads as a number, and a number comes back as its
	// digits — the same string either way.
	if err := s.db.QueryRow(`SELECT v FROM meta WHERE k='audit_watermark_action'`).Scan(&anchor.Action); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return AuditAnchor{}, false, nil
		}
		return AuditAnchor{}, false, err
	}
	return anchor, true, nil
}

// AuditRowMatches reports whether the row with the given rowid still
// carries the given content. False when the row is gone: the trail lost
// it, or it was reset and a different row took its place.
func (s *Store) AuditRowMatches(rowid int64, anchor AuditAnchor) (bool, error) {
	at, action, found, err := s.auditRowContent(rowid)
	if err != nil || !found {
		return false, err
	}
	return at == anchor.At && action == anchor.Action, nil
}

// auditRowContent returns the content of the audit row with that
// rowid — its (at, action) — and whether the row is there at all.
func (s *Store) auditRowContent(rowid int64) (int64, string, bool, error) {
	var at int64
	var action string
	err := s.db.QueryRow(`SELECT at, action FROM audit WHERE rowid=?`, rowid).Scan(&at, &action)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, "", false, nil
	}
	if err != nil {
		return 0, "", false, err
	}
	return at, action, true, nil
}

// LastAuditRowID returns the rowid of the newest row in the audit
// trail, 0 when the trail is empty.
//
// A watermark past it is stale: the trail was reset and its rowids
// started over, so the watermark points past every row that follows.
func (s *Store) LastAuditRowID() (int64, error) {
	var v int64
	if err := s.db.QueryRow(`SELECT COALESCE(MAX(rowid),0) FROM audit`).Scan(&v); err != nil {
		return 0, err
	}
	return v, nil
}

// AuditWatermarkStale reports whether the watermark points at a row the
// brain has not seen.
//
// The watermark is a rowid, and a rowid alone cannot answer that: a
// trail that was reset and refilled hands the same rowid to a different
// row, and the rows in between are lost for good. So the row's own
// content is stored next to the watermark when it is set, and the
// watermark is stale when the row is gone or is not the row the brain
// saw.
//
// A watermark with no anchor (a trail reported before the anchor
// existed) falls back to the numeric check: a watermark past the trail's
// last rowid is stale. That is the check that was there before, so an
// old database neither repairs itself nor loses a row.
func (s *Store) AuditWatermarkStale() (bool, error) {
	rowid, err := s.AuditWatermark()
	if err != nil {
		return false, err
	}
	if rowid == 0 {
		// Nothing was reported yet: the push starts at the beginning of
		// the trail, whatever it holds.
		return false, nil
	}
	anchor, ok, err := s.WatermarkAnchor()
	if err != nil {
		return false, err
	}
	if !ok {
		// No anchor: the database predates it. The numeric check is the
		// only thing there is.
		last, err := s.LastAuditRowID()
		if err != nil {
			return false, err
		}
		return rowid > last, nil
	}
	same, err := s.AuditRowMatches(rowid, anchor)
	if err != nil {
		return false, err
	}
	return !same, nil
}

// SetAuditWatermark moves the watermark forward to the given rowid: the
// rowid of the last audit row the brain has.
//
// The watermark never moves backwards: a rowid below the stored one is
// ignored. A lower one would re-offer rows the brain already has.
//
// The row's own content is stored next to it: the anchor that says "the
// row this watermark points at is still the row the brain has" (see
// AuditWatermarkStale). Both move in one statement, or not at all.
//
// The sweep writes it only after a successful push: a failed push leaves
// the watermark where it was, so the next sweep offers the same rows
// again and no row is lost.
func (s *Store) SetAuditWatermark(rowid int64) error {
	current, err := s.AuditWatermark()
	if err != nil {
		return err
	}
	if rowid <= current {
		// The watermark never moves backwards, and the anchor stays with
		// the row it belongs to.
		return nil
	}
	// The anchor: the row's own content, read here, where the row is. A
	// row that is not there leaves the anchor empty, and a missing row
	// is stale too.
	at, action, found, err := s.auditRowContent(rowid)
	if err != nil {
		return err
	}
	if !found {
		at, action = 0, ""
	}
	_, err = s.db.Exec(`INSERT INTO meta(k,v) VALUES('audit_watermark',?),('audit_watermark_at',?),('audit_watermark_action',?)
		ON CONFLICT(k) DO UPDATE SET v=CASE WHEN k='audit_watermark' THEN MAX(v,excluded.v) ELSE excluded.v END`, rowid, at, action)
	return err
}

// RepairAuditWatermark puts the watermark back to the start of the
// trail, and drops the anchor with it. The trail was reset — its
// rowids started over — so the stored watermark points at a row that is
// not the row the brain has, and the push would be silent for good. The
// trail's rows are offered again and the brain's dedup collapses the
// ones it already has.
func (s *Store) RepairAuditWatermark() error {
	if _, err := s.db.Exec(`INSERT INTO meta(k,v) VALUES('audit_watermark',0) ON CONFLICT(k) DO UPDATE SET v=0`); err != nil {
		return err
	}
	// The anchor named a row the watermark no longer names: it goes with
	// it. A watermark with no anchor falls back to the numeric check.
	_, err := s.db.Exec(`DELETE FROM meta WHERE k IN ('audit_watermark_at','audit_watermark_action')`)
	return err
}
