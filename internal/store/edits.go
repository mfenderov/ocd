package store

import "strings"

type PendingEdit struct {
	Token     string
	Device    string
	ChatID    int64
	MessageID int
	Note      string
}

func (s *Store) migrateEdits() error {
	for _, col := range []string{
		`ALTER TABLE link_tokens ADD COLUMN chat_id INTEGER DEFAULT 0`,
		`ALTER TABLE link_tokens ADD COLUMN message_id INTEGER DEFAULT 0`,
		`ALTER TABLE link_tokens ADD COLUMN edited INTEGER DEFAULT 0`,
	} {
		if _, err := s.db.Exec(col); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
			return err
		}
	}
	return nil
}

func (s *Store) SetLinkMessage(tok string, chatID int64, messageID int) error {
	_, err := s.db.Exec(`UPDATE link_tokens SET chat_id=?, message_id=? WHERE token=?`, chatID, messageID, tok)
	return err
}

// PendingEdits returns taps needing a chat update: consumed-but-unmarked
// links ("used") and expired untouched links ("expired").
func (s *Store) PendingEdits() []PendingEdit {
	rows, err := s.db.Query(`SELECT token, device, chat_id, message_id,
		CASE WHEN used_at IS NOT NULL THEN 'used' ELSE 'expired' END
		FROM link_tokens WHERE edited=0 AND chat_id!=0 AND message_id!=0
		AND (used_at IS NOT NULL OR created_at<strftime('%s','now')-?)`, int64(linkTTL.Seconds()))
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []PendingEdit
	for rows.Next() {
		var p PendingEdit
		if err := rows.Scan(&p.Token, &p.Device, &p.ChatID, &p.MessageID, &p.Note); err == nil {
			out = append(out, p)
		}
	}
	return out
}

func (s *Store) MarkEdited(tok string) {
	_, _ = s.db.Exec(`UPDATE link_tokens SET edited=1 WHERE token=?`, tok)
}
