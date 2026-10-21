package store

import (
	"context"
	"strings"
)

func (s *Store) migrateEdits(ctx context.Context) error {
	for _, col := range []string{
		`ALTER TABLE link_tokens ADD COLUMN chat_id INTEGER DEFAULT 0`,
		`ALTER TABLE link_tokens ADD COLUMN message_id INTEGER DEFAULT 0`,
		`ALTER TABLE link_tokens ADD COLUMN edited INTEGER DEFAULT 0`,
		`ALTER TABLE link_tokens ADD COLUMN used_ua TEXT DEFAULT ''`,
		`ALTER TABLE link_tokens ADD COLUMN used_ip TEXT DEFAULT ''`,
	} {
		if _, err := s.db.ExecContext(ctx, col); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
			return err
		}
	}
	return nil
}

func (s *Store) SetUsedMeta(ctx context.Context, tok, ip, ua string) {
	_, _ = s.db.ExecContext(ctx, `UPDATE link_tokens SET used_ua=?, used_ip=? WHERE token=?`, truncateUA(ua), ip, tok)
}
