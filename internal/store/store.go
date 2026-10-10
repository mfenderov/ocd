package store

import (
	"database/sql"
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
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
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
