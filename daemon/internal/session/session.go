// Package session opens session.db, the library's own store, through the same connection string
// as store.db. Opening it applies the library's migrations; nothing here connects to WhatsApp.
package session

import (
	"context"
	"fmt"
	"log/slog"

	"go.mau.fi/whatsmeow/store/sqlstore"
	waLog "go.mau.fi/whatsmeow/util/log"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/sqlite"
)

// Open opens and migrates session.db and reports whether it holds a linked device.
func Open(ctx context.Context, path string, log *slog.Logger) (*sqlstore.Container, bool, error) {
	c, err := sqlstore.New(ctx, sqlite.Driver, sqlite.DSN(path, false), Logger(log, "session"))
	if err != nil {
		return nil, false, fmt.Errorf("open session.db: %w", err)
	}
	devs, err := c.GetAllDevices(ctx)
	if err != nil {
		c.Close()
		return nil, false, fmt.Errorf("read session.db: %w", err)
	}
	return c, len(devs) > 0 && devs[0].ID != nil, nil
}

// Logger adapts slog to the library's logger at warning level or quieter, because the library's
// debug and info logs include message ids and senders (scopes.md "Library settings").
func Logger(log *slog.Logger, module string) waLog.Logger {
	return &walog{log: log.With("module", module)}
}

type walog struct{ log *slog.Logger }

func (w *walog) Warnf(msg string, args ...any)  { w.log.Warn(fmt.Sprintf(msg, args...)) }
func (w *walog) Errorf(msg string, args ...any) { w.log.Error(fmt.Sprintf(msg, args...)) }
func (w *walog) Infof(string, ...any)           {}
func (w *walog) Debugf(string, ...any)          {}
func (w *walog) Sub(module string) waLog.Logger { return &walog{log: w.log.With("sub", module)} }
