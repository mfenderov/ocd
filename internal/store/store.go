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
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS devices(name TEXT PRIMARY KEY, platform TEXT, last_cookie_at INTEGER, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS mints(id INTEGER PRIMARY KEY AUTOINCREMENT, device TEXT, via TEXT, at INTEGER);`)
	return err
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

// TapStats reports tap count in the window and seconds since last tap (or -1).
func (s *Store) TapStats(device string, d time.Duration) (count int, sinceLast int64) {
	since := time.Now().Add(-d).Unix()
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM link_tokens WHERE device=? AND used_at IS NOT NULL AND used_at>=?`, device, since).Scan(&count)
	var last sql.NullInt64
	_ = s.db.QueryRow(`SELECT MAX(used_at) FROM link_tokens WHERE device=? AND used_at IS NOT NULL`, device).Scan(&last)
	if !last.Valid {
		return count, -1
	}
	return count, time.Now().Unix() - last.Int64
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
