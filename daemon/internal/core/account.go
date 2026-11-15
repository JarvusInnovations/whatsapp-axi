// Package core is the inside of one account's daemon: it applies the scope to incoming messages,
// keeps what the scope keeps (store.db rows, events, wake lines), counts what it discards, and
// answers the read-only and settings requests. It knows nothing about sockets or WhatsApp
// wire formats.
package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/identity"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/paths"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/settings"
)

// Protocol is the socket protocol version (socket-protocol.md "Version check").
const Protocol = 1

// Options configure an Account.
type Options struct {
	Layout         paths.Layout
	DB             *sql.DB
	Client         client.Client
	Settings       settings.Settings
	Log            *slog.Logger
	Now            func() time.Time
	DaemonVersion  string
	LibraryVersion string
}

// Account is one running account.
type Account struct {
	layout   paths.Layout
	db       *sql.DB
	client   client.Client
	log      *slog.Logger
	now      func() time.Time
	versions [2]string

	// mu serialises every write: incoming messages, settings changes, forget, retention.
	mu       sync.Mutex
	settings settings.Settings
	buffer   *recentBuffer

	stateMu sync.Mutex
	state   string
	reason  string
	since   time.Time

	notify *notifier
}

// New builds an Account and records the client's initial state.
func New(ctx context.Context, o Options) (*Account, error) {
	if o.Now == nil {
		o.Now = time.Now
	}
	a := &Account{
		layout:   o.Layout,
		db:       o.DB,
		client:   o.Client,
		log:      o.Log,
		now:      o.Now,
		versions: [2]string{o.DaemonVersion, o.LibraryVersion},
		settings: o.Settings,
		buffer:   newRecentBuffer(),
		notify:   newNotifier(),
	}
	st, reason := o.Client.State()
	if err := a.enterState(ctx, st, reason, true); err != nil {
		return nil, err
	}
	return a, nil
}

// Name is the account name.
func (a *Account) Name() string { return a.layout.Account }

// Handle is the client.Handler of the account.
func (a *Account) Handle(ev client.Event) {
	ctx := context.Background()
	switch e := ev.(type) {
	case *client.Message:
		if err := a.handleMessage(ctx, e); err != nil {
			// The error text never contains message content: every error below is from SQL or
			// the file system, and none wraps a value from the message.
			a.log.Error("handling an incoming message failed", "err", err)
		}
	case client.StateChange:
		if err := a.enterState(ctx, e.State, e.Reason, false); err != nil {
			a.log.Error("recording a state change failed", "err", err)
		}
	case client.PhoneActivity:
		a.setMeta(ctx, "last_phone_activity", rfc3339(e.Time))
	}
}

// State returns the current state, reason and since.
func (a *Account) State() (string, string, time.Time) {
	a.stateMu.Lock()
	defer a.stateMu.Unlock()
	return a.state, a.reason, a.since
}

// enterState records a state; a change from the last recorded state emits a state event.
func (a *Account) enterState(ctx context.Context, st, reason string, initial bool) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	last, _ := a.meta(ctx, "state")
	now := a.now()
	a.stateMu.Lock()
	changed := initial && last != st || !initial && a.state != st
	if changed || initial {
		a.state, a.reason, a.since = st, reason, now
	}
	a.stateMu.Unlock()
	if !changed {
		return nil
	}
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := a.insertEvent(ctx, tx, KindState, "", "", false, Event{State: st, Reason: reason}); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO meta(key, value) VALUES('state', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, st); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	a.log.Info("state", "state", st, "reason", reason)
	a.notify.Notify()
	return nil
}

func (a *Account) meta(ctx context.Context, key string) (string, error) {
	var v string
	err := a.db.QueryRowContext(ctx, `SELECT value FROM meta WHERE key=?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

func (a *Account) setMeta(ctx context.Context, key, value string) {
	if _, err := a.db.ExecContext(ctx, `INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value); err != nil {
		a.log.Error("writing meta failed", "key", key, "err", err)
	}
}

// own returns the account's own ids.
func (a *Account) own() identity.Own {
	o := a.client.OwnIDs()
	return identity.Own{PN: identity.NonAD(o.PN), LID: identity.NonAD(o.LID)}
}

// pair resolves the two forms of a user id from a raw id and an optional alternate.
func (a *Account) pair(ctx context.Context, raw, alt string, request bool) (lid, pn string) {
	n, an := identity.NonAD(raw), identity.NonAD(alt)
	switch {
	case identity.IsLID(n):
		lid = n
		if identity.IsPN(an) {
			pn = an
		} else {
			pn = a.client.PNForLID(ctx, lid)
		}
	case identity.IsPN(n):
		pn = n
		if identity.IsLID(an) {
			lid = an
		} else {
			lid = a.client.LIDForPN(ctx, pn)
		}
	}
	if request && lid != "" && pn == "" {
		a.client.RequestMapping(ctx, lid)
	}
	return lid, pn
}

// user builds a user object. pushName is the sender's self-chosen name, used when the account has
// no address-book name for them.
func (a *Account) user(ctx context.Context, raw, alt, pushName string, own identity.Own, operators []string, request bool) User {
	lid, pn := a.pair(ctx, raw, alt, request)
	u := User{LID: lid, PN: identity.PhoneOf(pn)}
	switch {
	case lid != "":
		u.ID = lid
	case pn != "":
		u.ID = pn
	default:
		u.ID = identity.NonAD(raw)
	}
	u.Me = own.IsMe(raw) || own.IsMe(alt) || own.IsMe(lid) || own.IsMe(pn)
	u.Operator = identity.IsOperator(lid, pn, operators)
	if name, ok := a.client.Contact(ctx, u.ID); ok && name != "" {
		u.Name = name
	} else if pn != "" && pn != u.ID {
		if name, ok := a.client.Contact(ctx, pn); ok && name != "" {
			u.Name = name
		}
	}
	if u.Name == "" {
		u.Name = pushName
	}
	return u
}

func (a *Account) isContact(ctx context.Context, u User) bool {
	if _, ok := a.client.Contact(ctx, u.ID); ok {
		return true
	}
	if u.PN != "" {
		if _, ok := a.client.Contact(ctx, identity.PNOfPhone(u.PN)); ok {
			return true
		}
	}
	return false
}

// Settings returns a copy of the current settings.
func (a *Account) Settings() settings.Settings {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.settings
}

// notifier wakes followers when events are committed.
type notifier struct {
	mu   sync.Mutex
	subs map[chan struct{}]struct{}
}

func newNotifier() *notifier { return &notifier{subs: map[chan struct{}]struct{}{}} }

// Subscribe returns a channel signalled after each commit of events, and a cancel function.
func (n *notifier) Subscribe() (<-chan struct{}, func()) {
	c := make(chan struct{}, 1)
	n.mu.Lock()
	n.subs[c] = struct{}{}
	n.mu.Unlock()
	return c, func() {
		n.mu.Lock()
		delete(n.subs, c)
		n.mu.Unlock()
	}
}

func (n *notifier) Notify() {
	n.mu.Lock()
	defer n.mu.Unlock()
	for c := range n.subs {
		select {
		case c <- struct{}{}:
		default:
		}
	}
}

// Subscribe registers for event notifications.
func (a *Account) Subscribe() (<-chan struct{}, func()) { return a.notify.Subscribe() }

func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}
