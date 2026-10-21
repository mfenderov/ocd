package store

import (
	"context"
	"database/sql"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type Device struct {
	Name      string
	Platform  string
	ExpiresAt int64
}

type Store struct {
	db *sql.DB
	// pruning counts the background writers, so Close can wait for them.
	pruning sync.WaitGroup
}

// Open opens the store at path and migrates it. The context bounds the
// setup: the caller owns the lifetime of the work, not the store.
func Open(ctx context.Context, path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	// Single connection: :memory: databases are per-connection, and the
	// check-then-claim in ConsumeLink must not interleave.
	db.SetMaxOpenConns(1)
	// A writer that finds the database locked waits for the lock instead
	// of failing: the store prunes in the background while the box
	// writes, and a second process (the CLI while the daemon runs) can
	// write at the same time. Without the wait, the loser of the race
	// loses a row — a busy error, not a slow one.
	if _, err := db.ExecContext(ctx, `PRAGMA busy_timeout = 5000`); err != nil {
		db.Close()
		return nil, err
	}
	s := &Store{db: db}
	if err := s.migrateAll(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// migrateAll creates the schema the store needs.
func (s *Store) migrateAll(ctx context.Context) error {
	migrations := []func(context.Context) error{
		s.migrate, s.migrateLinks, s.migrateIdem, s.migrateEdits,
	}
	for _, migrate := range migrations {
		if err := migrate(ctx); err != nil {
			return err
		}
	}
	return nil
}

// Close closes the store. It waits for the background writers first: a
// prune that outlived its store would keep the database locked for
// whoever writes next.
func (s *Store) Close() error {
	s.pruning.Wait()
	return s.db.Close()
}

func (s *Store) migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS devices(name TEXT PRIMARY KEY, `+
		`platform TEXT, last_cookie_at INTEGER, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS mints(id INTEGER PRIMARY KEY AUTOINCREMENT, device TEXT, via TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0);`)
	return err
}

// PasswordEpoch returns the persisted password-epoch counter, 0 if unset.
func (s *Store) PasswordEpoch(ctx context.Context) int {
	var v int
	if err := s.db.QueryRowContext(ctx, `SELECT v FROM meta WHERE k='password_epoch'`).Scan(&v); err != nil {
		return 0
	}
	return v
}

// BumpEpoch increments the persisted password-epoch counter and returns it.
func (s *Store) BumpEpoch(ctx context.Context) int {
	_, _ = s.db.ExecContext(ctx, `INSERT INTO meta(k,v) VALUES('password_epoch',1) ON CONFLICT(k) DO UPDATE SET v=v+1`)
	return s.PasswordEpoch(ctx)
}

// NextHeartbeatSeq increments the persisted heartbeat sequence and returns it.
// Starts at 1, +1 per call.
func (s *Store) NextHeartbeatSeq(ctx context.Context) int64 {
	_, _ = s.db.ExecContext(ctx, `INSERT INTO meta(k,v) VALUES('heartbeat_seq',1) ON CONFLICT(k) DO UPDATE SET v=v+1`)
	var v int64
	_ = s.db.QueryRowContext(ctx, `SELECT v FROM meta WHERE k='heartbeat_seq'`).Scan(&v)
	return v
}

func (s *Store) AddDevice(ctx context.Context, name, platform string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO devices(name, platform, last_cookie_at, expires_at) VALUES(?,?,0,0)
	ON CONFLICT(name) DO UPDATE SET platform=excluded.platform`, name, platform)
	return err
}

func (s *Store) GetDevice(ctx context.Context, name string) (Device, bool) {
	var d Device
	err := s.db.QueryRowContext(ctx, `SELECT name, platform, expires_at FROM devices WHERE `+
		`name=?`, name).Scan(&d.Name, &d.Platform, &d.ExpiresAt)
	return d, err == nil
}

func (s *Store) ListDevices(ctx context.Context) []string {
	rows, err := s.db.QueryContext(ctx, `SELECT name FROM devices ORDER BY name`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			continue
		}
		out = append(out, n)
	}
	if err := rows.Err(); err != nil {
		return nil
	}
	return out
}

func (s *Store) TouchMint(ctx context.Context, device, via string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO mints(device, via, at) VALUES(?,?,strftime('%s','now'))`, device, via)
	return err
}

func (s *Store) CountRecentMints(ctx context.Context, device string, d time.Duration) int {
	since := time.Now().Add(-d).Unix()
	var n int
	if device == "" {
		_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM mints WHERE at>=?`, since).Scan(&n)
		return n
	}
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM mints WHERE device=? AND at>=?`, device, since).Scan(&n)
	return n
}

func (s *Store) RefreshExpiry(ctx context.Context, name string, d time.Duration) error {
	_, err := s.db.ExecContext(ctx, `UPDATE devices SET last_cookie_at=strftime('%s','now'), `+
		`expires_at=strftime('%s','now')+? WHERE name=?`, int64(d.Seconds()), name)
	return err
}

func (s *Store) ExpireDevice(ctx context.Context, name string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE devices SET last_cookie_at=0, expires_at=0 WHERE name=?`, name)
	return err
}
