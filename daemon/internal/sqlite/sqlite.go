// Package sqlite is the one place the SQLite connection string is built (specs/distribution.md).
// Both databases are opened through it: pure Go (no CGO), foreign keys on, WAL journaling and a
// busy timeout.
package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"

	_ "modernc.org/sqlite" // registers the "sqlite" driver
)

// Driver is the database/sql driver name of modernc.org/sqlite. whatsmeow's dbutil parses any
// name starting with "sqlite" as the SQLite dialect.
const Driver = "sqlite"

// DSN returns the connection string for path. secureDelete overwrites deleted content, which
// specs/security.md requires for store.db.
func DSN(path string, secureDelete bool) string {
	u := url.URL{Scheme: "file", Path: path}
	q := "_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(10000)&_pragma=synchronous(NORMAL)"
	if secureDelete {
		q += "&_pragma=secure_delete(1)"
	}
	return u.String() + "?" + q
}

// Open opens path and checks that foreign keys are on.
func Open(ctx context.Context, path string, secureDelete bool) (*sql.DB, error) {
	db, err := sql.Open(Driver, DSN(path, secureDelete))
	if err != nil {
		return nil, err
	}
	var fk int
	if err := db.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&fk); err != nil {
		db.Close()
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	if fk != 1 {
		db.Close()
		return nil, fmt.Errorf("open %s: foreign keys are not enabled", path)
	}
	return db, nil
}
