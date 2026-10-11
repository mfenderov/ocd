package store

func (s *Store) migrateIdem() error {
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS idem(key TEXT PRIMARY KEY, token TEXT, created_at INTEGER)`)
	return err
}

// RecordIdem maps an idempotency key to its minted proxy token,
// replacing any prior mapping for a re-mint after claim or expiry.
func (s *Store) RecordIdem(key, token string) error {
	_, err := s.db.Exec(`INSERT INTO idem(key, token, created_at) VALUES(?,?,strftime('%s','now'))
	ON CONFLICT(key) DO UPDATE SET token=excluded.token, created_at=excluded.created_at`, key, token)
	return err
}

// LookupIdem returns the token for key only while that token is still
// unclaimed and inside the link TTL. Same predicate as ConsumeLink,
// without consuming.
func (s *Store) LookupIdem(key string) (string, bool) {
	var tok string
	if err := s.db.QueryRow(`SELECT token FROM idem WHERE key=?`, key).Scan(&tok); err != nil {
		return "", false
	}
	var device string
	err := s.db.QueryRow(`SELECT device FROM link_tokens WHERE token=? AND used_at IS NULL AND created_at>=strftime('%s','now')-?`, tok, int64(linkTTL.Seconds())).Scan(&device)
	if err != nil {
		return "", false
	}
	return tok, true
}
