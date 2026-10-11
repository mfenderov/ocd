package store

import (
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

type Device struct {
	Name      string
	Platform  string
	ExpiresAt int64
}

type Store struct{ db *sql.DB }

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	// Single connection: :memory: databases are per-connection, and the
	// check-then-claim in ConsumeLink must not interleave.
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	if err := s.migrateLinks(); err != nil {
		db.Close()
		return nil, err
	}
	if err := s.migrateEdits(); err != nil {
		db.Close()
		return nil, err
	}
	if err := s.migrateSeen(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS devices(name TEXT PRIMARY KEY, platform TEXT, last_cookie_at INTEGER, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS mints(id INTEGER PRIMARY KEY AUTOINCREMENT, device TEXT, via TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0);`)
	return err
}

// PasswordEpoch returns the persisted password-epoch counter, 0 if unset.
func (s *Store) PasswordEpoch() int {
	var v int
	if err := s.db.QueryRow(`SELECT v FROM meta WHERE k='password_epoch'`).Scan(&v); err != nil {
		return 0
	}
	return v
}

// BumpEpoch increments the persisted password-epoch counter and returns it.
func (s *Store) BumpEpoch() int {
	_, _ = s.db.Exec(`INSERT INTO meta(k,v) VALUES('password_epoch',1) ON CONFLICT(k) DO UPDATE SET v=v+1`)
	return s.PasswordEpoch()
}

func (s *Store) AddDevice(name, platform string) error {
	_, err := s.db.Exec(`INSERT INTO devices(name, platform, last_cookie_at, expires_at) VALUES(?,?,0,0)
	ON CONFLICT(name) DO UPDATE SET platform=excluded.platform`, name, platform)
	return err
}

func (s *Store) GetDevice(name string) (Device, bool) {
	var d Device
	err := s.db.QueryRow(`SELECT name, platform, expires_at FROM devices WHERE name=?`, name).Scan(&d.Name, &d.Platform, &d.ExpiresAt)
	return d, err == nil
}

func (s *Store) ListDevices() []string {
	rows, err := s.db.Query(`SELECT name FROM devices ORDER BY name`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err == nil {
			out = append(out, n)
		}
	}
	return out
}

func (s *Store) TouchMint(device, via string) error {
	_, err := s.db.Exec(`INSERT INTO mints(device, via, at) VALUES(?,?,strftime('%s','now'))`, device, via)
	return err
}

func (s *Store) CountRecentMints(device string, d time.Duration) int {
	since := time.Now().Add(-d).Unix()
	var n int
	if device == "" {
		_ = s.db.QueryRow(`SELECT COUNT(*) FROM mints WHERE at>=?`, since).Scan(&n)
		return n
	}
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM mints WHERE device=? AND at>=?`, device, since).Scan(&n)
	return n
}

func (s *Store) RefreshExpiry(name string, d time.Duration) error {
	_, err := s.db.Exec(`UPDATE devices SET last_cookie_at=strftime('%s','now'), expires_at=strftime('%s','now')+? WHERE name=?`, int64(d.Seconds()), name)
	return err
}

func (s *Store) ExpireDevice(name string) error {
	_, err := s.db.Exec(`UPDATE devices SET last_cookie_at=0, expires_at=0 WHERE name=?`, name)
	return err
}

type SeenClient struct {
	IP    string
	UA    string
	Count int
	Last  int64
}

// SeenClients lists real tapping clients from the audit trail: distinct
// IP + UA pairs with tap counts. Ground truth, no manual entries.
func (s *Store) SeenClients() []SeenClient {
	rows, err := s.db.Query(`SELECT ip, ua, COUNT(*), MAX(at) FROM audit
		WHERE action IN ('tapped','consumed') GROUP BY ip, ua ORDER BY MAX(at) DESC`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []SeenClient
	for rows.Next() {
		var c SeenClient
		var ua sql.NullString
		if err := rows.Scan(&c.IP, &ua, &c.Count, &c.Last); err == nil {
			c.UA = ua.String
			out = append(out, c)
		}
	}
	return out
}

func (s *Store) migrateSeen() error {
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS seen_updates(id INTEGER PRIMARY KEY, at INTEGER);`)
	return err
}

// SeenUpdate records a processed Telegram update ID for replay dedup.
func (s *Store) SeenUpdate(id int64) bool {
	var n int
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM seen_updates WHERE id=?`, id).Scan(&n)
	if n > 0 {
		return true
	}
	_, _ = s.db.Exec(`INSERT INTO seen_updates(id, at) VALUES(?,strftime('%s','now'))`, id)
	_, _ = s.db.Exec(`DELETE FROM seen_updates WHERE at<strftime('%s','now')-?`, int64((24 * 60 * 60)))
	return false
}

func FmtAgo(s int64) string {
	if s < 0 {
		return "never"
	}
	if s < 90 {
		return "just now"
	}
	if s < 3600 {
		return fmt.Sprintf("%dm ago", s/60)
	}
	if s < 86400 {
		return fmt.Sprintf("%dh ago", s/3600)
	}
	return fmt.Sprintf("%dd ago", s/86400)
}
