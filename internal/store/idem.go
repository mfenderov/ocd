package store

import "context"

func (s *Store) migrateIdem(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS idem(key TEXT PRIMARY KEY, `+
		`token TEXT, created_at INTEGER)`)
	return err
}

// ClaimIdem atomically maps key to token when the key is new or its
// current token is claimed or expired, and reports whether this caller
// owns the key. Concurrent claimants serialize on the single SQLite
// connection: exactly one wins, the rest see the winner's live token
// via LookupIdem. No in-memory locking needed, across handler instances
// or restarts.
func (s *Store) ClaimIdem(ctx context.Context, key, token string) bool {
	res, err := s.db.ExecContext(ctx, `INSERT INTO idem(key, token, created_at) VALUES(?,?,strftime('%s','now'))
	ON CONFLICT(key) DO UPDATE SET token=excluded.token, created_at=excluded.created_at
	WHERE NOT EXISTS (SELECT 1 FROM link_tokens WHERE link_tokens.token=idem.token
		AND used_at IS NULL AND created_at>=strftime('%s','now')-?)`,
		key, token, int64(linkTTL.Seconds()))
	if err != nil {
		return false
	}
	n, _ := res.RowsAffected()
	return n == 1
}

// ReleaseIdem drops key's mapping when it still points at token, rolling
// back a claim whose mint failed so the next retry mints fresh.
func (s *Store) ReleaseIdem(ctx context.Context, key, token string) {
	_, _ = s.db.ExecContext(ctx, `DELETE FROM idem WHERE key=? AND token=?`, key, token)
}

// LookupIdem returns the token for key only while that token is still
// unclaimed and inside the link TTL. Same predicate as ConsumeLink,
// without consuming. The idem row's own age is not consulted.
func (s *Store) LookupIdem(ctx context.Context, key string) (string, bool) {
	var tok string
	if err := s.db.QueryRowContext(ctx, `SELECT token FROM idem WHERE key=?`, key).Scan(&tok); err != nil {
		return "", false
	}
	var device string
	err := s.db.QueryRowContext(ctx, `SELECT device FROM link_tokens WHERE token=? AND used_at IS NULL AND `+
		`created_at>=strftime('%s','now')-?`, tok, int64(linkTTL.Seconds())).Scan(&device)
	if err != nil {
		return "", false
	}
	return tok, true
}
