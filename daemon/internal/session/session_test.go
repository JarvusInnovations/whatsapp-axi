package session

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/sqlite"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/store"
)

// TestBothDatabasesOpenAndMigrate covers specs/distribution.md: the one connection string opens
// and migrates both databases, with foreign keys, WAL and a busy timeout on.
func TestBothDatabasesOpenAndMigrate(t *testing.T) {
	ctx := context.Background()
	dir := filepath.Join(t.TempDir(), "dir with space")
	if err := mkdir(dir); err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	c, has, err := Open(ctx, filepath.Join(dir, "session.db"), log)
	if err != nil {
		t.Fatal(err)
	}
	if has {
		t.Fatal("a new session.db holds no device")
	}
	c.Close()
	// Reopening applies no migration twice.
	c, _, err = Open(ctx, filepath.Join(dir, "session.db"), log)
	if err != nil {
		t.Fatal(err)
	}
	c.Close()

	db, err := store.Open(ctx, filepath.Join(dir, "store.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var fk, busy, secure int
	var mode string
	db.QueryRow("PRAGMA foreign_keys").Scan(&fk)
	db.QueryRow("PRAGMA journal_mode").Scan(&mode)
	db.QueryRow("PRAGMA busy_timeout").Scan(&busy)
	db.QueryRow("PRAGMA secure_delete").Scan(&secure)
	if fk != 1 || strings.ToLower(mode) != "wal" || busy == 0 || secure != 1 {
		t.Fatalf("pragmas: fk=%d journal=%s busy=%d secure_delete=%d", fk, mode, busy, secure)
	}
	var v int
	db.QueryRow("PRAGMA user_version").Scan(&v)
	if v != store.Version() {
		t.Fatalf("schema version %d", v)
	}
	// Foreign keys are enforced.
	if _, err := db.Exec(`INSERT INTO messages(chat_id, id, sender_id, sender_raw, from_me, operator, ts, kept_by) VALUES('nope@g.us','x','a','a',0,0,0,'own')`); err == nil {
		t.Fatal("a message without its chat was accepted")
	}
	if err := store.Migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sqlite.DSN("/x/y.db", true), "foreign_keys(1)") {
		t.Fatal("DSN")
	}
}

func mkdir(p string) error { return os.MkdirAll(p, 0o700) }
