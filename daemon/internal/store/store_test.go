package store

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/sqlite"
)

// A store.db from before read_marked existed: every message in it was kept under on-keep, which
// marked it read then, so the migration records it as marked and no later mark sends a second
// receipt.
func TestMigrationMarksExistingMessagesRead(t *testing.T) {
	ctx := context.Background()
	db, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "store.db"), true)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, q := range []string{
		migrations[0],
		`PRAGMA user_version = 1`,
		`INSERT INTO chats(id, type, created_at) VALUES('120363000000000001@g.us', 'group', 0)`,
		`INSERT INTO messages(chat_id, id, sender_id, sender_raw, from_me, operator, ts, kept_by) VALUES('120363000000000001@g.us', '3EB0AAAA0000000001', '100000000000001@lid', '100000000000001@lid', 0, 0, 0, 'mention')`,
	} {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	if err := Migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	var marked int
	if err := db.QueryRowContext(ctx, `SELECT read_marked FROM messages`).Scan(&marked); err != nil || marked != 1 {
		t.Fatalf("read_marked %d %v", marked, err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO messages(chat_id, id, sender_id, sender_raw, from_me, operator, ts, kept_by) VALUES('120363000000000001@g.us', '3EB0AAAA0000000002', '100000000000001@lid', '100000000000001@lid', 0, 0, 0, 'mention')`); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT read_marked FROM messages WHERE id='3EB0AAAA0000000002'`).Scan(&marked); err != nil || marked != 0 {
		t.Fatalf("a new message starts unmarked: %d %v", marked, err)
	}
}
