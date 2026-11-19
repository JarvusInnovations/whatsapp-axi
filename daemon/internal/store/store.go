// Package store owns the schema of store.db: kept messages, the account's own messages, chats,
// chat aliases, reactions, discard counters and the event sequence.
package store

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/sqlite"
)

// migrations are applied in order; the index+1 is the schema version.
var migrations = []string{
	`
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE chats (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_kept_at INTEGER
);
CREATE TABLE chat_aliases (
  alias   TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX chat_aliases_chat ON chat_aliases(chat_id);
CREATE TABLE discard_counters (
  chat_key TEXT PRIMARY KEY,
  n        INTEGER NOT NULL
);
CREATE TABLE messages (
  chat_id      TEXT NOT NULL REFERENCES chats(id) ON UPDATE CASCADE ON DELETE CASCADE,
  id           TEXT NOT NULL,
  sender_id    TEXT NOT NULL,
  sender_raw   TEXT NOT NULL,
  sender_lid   TEXT NOT NULL DEFAULT '',
  sender_pn    TEXT NOT NULL DEFAULT '',
  sender_name  TEXT NOT NULL DEFAULT '',
  from_me      INTEGER NOT NULL,
  operator     INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  text         TEXT NOT NULL DEFAULT '',
  kept_by      TEXT NOT NULL,
  partial      INTEGER NOT NULL DEFAULT 0,
  mentions_me  INTEGER NOT NULL DEFAULT 0,
  mentions     TEXT NOT NULL DEFAULT '[]',
  reply_id     TEXT NOT NULL DEFAULT '',
  reply_raw    TEXT NOT NULL DEFAULT '',
  reply_from   TEXT NOT NULL DEFAULT '',
  reply_text   TEXT NOT NULL DEFAULT '',
  media        TEXT NOT NULL DEFAULT '',
  media_keys   BLOB,
  media_path   TEXT NOT NULL DEFAULT '',
  ephemeral    INTEGER NOT NULL DEFAULT 0,
  edited       INTEGER NOT NULL DEFAULT 0,
  deleted      INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'received',
  PRIMARY KEY (chat_id, id)
);
CREATE INDEX messages_ts ON messages(ts);
CREATE INDEX messages_id ON messages(id);
CREATE INDEX messages_chat_ts ON messages(chat_id, ts);
CREATE TABLE reactions (
  chat_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_id  TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id, sender_id),
  FOREIGN KEY (chat_id, message_id) REFERENCES messages(chat_id, id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE TABLE events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  t          INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  chat_id    TEXT REFERENCES chats(id) ON UPDATE CASCADE ON DELETE CASCADE,
  message_id TEXT NOT NULL DEFAULT '',
  from_me    INTEGER NOT NULL DEFAULT 0,
  payload    TEXT NOT NULL
);
CREATE INDEX events_chat ON events(chat_id, seq);
CREATE INDEX events_message ON events(chat_id, message_id);
`,
	// read_marked records that a read receipt was sent for a message, so marking is idempotent.
	// Every message kept before it was kept under read_receipts on-keep, which marked it then.
	`
ALTER TABLE messages ADD COLUMN read_marked INTEGER NOT NULL DEFAULT 0;
UPDATE messages SET read_marked=1;
`,
}

// Open opens store.db with secure deletion on and applies migrations.
func Open(ctx context.Context, path string) (*sql.DB, error) {
	db, err := sqlite.Open(ctx, path, true)
	if err != nil {
		return nil, err
	}
	if err := Migrate(ctx, db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// Migrate brings the schema to the latest version.
func Migrate(ctx context.Context, db *sql.DB) error {
	var version int
	if err := db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version > len(migrations) {
		return fmt.Errorf("store.db has schema version %d, newer than this daemon knows (%d)", version, len(migrations))
	}
	for i := version; i < len(migrations); i++ {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, migrations[i]); err != nil {
			tx.Rollback()
			return fmt.Errorf("store.db migration %d: %w", i+1, err)
		}
		if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", i+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// Version returns the schema version this daemon writes.
func Version() int { return len(migrations) }
