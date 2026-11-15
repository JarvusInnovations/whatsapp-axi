// Package runner implements the daemon's subcommands: the start sequence of `run`
// (specs/daemon.md "Starting"), `init` and `remove`.
package runner

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"runtime/debug"
	"syscall"
	"time"

	"go.mau.fi/whatsmeow/store/sqlstore"
	"golang.org/x/sys/unix"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client/offline"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/core"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/lockfile"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/paths"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/server"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/session"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/settings"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/store"
)

// LibraryModule is the WhatsApp library whose version is reported.
const LibraryModule = "go.mau.fi/whatsmeow"

// LibraryVersion is stamped at build time with -ldflags; otherwise it is read from the build info.
var LibraryVersion = ""

// Library returns the version of the WhatsApp library compiled in.
func Library() string {
	if LibraryVersion != "" {
		return LibraryVersion
	}
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, d := range bi.Deps {
			if d.Path == LibraryModule {
				if d.Replace != nil {
					return d.Replace.Version
				}
				return d.Version
			}
		}
	}
	return "unknown"
}

// Errors the CLI distinguishes by message.
var (
	ErrAlreadyRunning = errors.New("already running")
	ErrNoAccount      = errors.New("no such account")
	ErrAccountExists  = errors.New("account exists")
)

// Options configure Run.
type Options struct {
	Account string
	Getenv  paths.Getenv
	Version string
	Log     io.Writer
	Level   slog.Level
	// NewClient builds the WhatsApp client over the opened session store; nil uses the offline
	// client. cmd/whatsapp-axid passes the whatsmeow adapter (client/wa).
	NewClient func(session *sqlstore.Container, hasSession bool, log *slog.Logger) client.Client
	// PeerUID overrides the kernel peer-credential lookup (tests).
	PeerUID server.PeerUID
	// Ready, when set, receives the account once the socket is listening.
	Ready func(*core.Account)
	// Now overrides the clock (tests).
	Now func() time.Time
}

// Run runs the account's daemon until ctx ends.
func Run(ctx context.Context, o Options) error {
	if o.Getenv == nil {
		o.Getenv = os.Getenv
	}
	if o.Log == nil {
		o.Log = os.Stderr
	}
	log := slog.New(slog.NewTextHandler(o.Log, &slog.HandlerOptions{Level: o.Level})).With("account", o.Account)

	syscall.Umask(0o077)
	if err := DisableCoreDumps(); err != nil {
		return fmt.Errorf("cannot disable core dumps: %w", err)
	}

	l, err := paths.Resolve(o.Account, o.Getenv)
	if err != nil {
		return err
	}
	if _, err := os.Stat(l.SettingsFile()); errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("%w %q: create it with `whatsapp-axid init --account %s`", ErrNoAccount, o.Account, o.Account)
	}

	// 1. Owner-only files and directories.
	if err := CheckModes(l); err != nil {
		return err
	}

	// 2. The lock.
	lock, err := lockfile.Acquire(l.LockFile())
	if errors.Is(err, lockfile.ErrHeld) {
		return fmt.Errorf("account %q: %w", o.Account, ErrAlreadyRunning)
	} else if err != nil {
		return fmt.Errorf("cannot take the lock: %w", err)
	}
	defer lock.Release()

	s, err := settings.Load(l.SettingsFile())
	if err != nil {
		return err
	}

	// 3. The socket.
	ln, err := Listen(l)
	if err != nil {
		return err
	}
	defer os.Remove(l.Socket())
	defer ln.Close()

	// 4. The databases.
	db, err := store.Open(ctx, l.StoreDB())
	if err != nil {
		return err
	}
	defer db.Close()
	sess, hasSession, err := session.Open(ctx, l.SessionDB(), log)
	if err != nil {
		return err
	}
	defer sess.Close()
	for _, p := range []string{l.StoreDB(), l.SessionDB()} {
		_ = os.Chmod(p, 0o600)
	}

	// 5. The state the session implies.
	var cl client.Client
	if o.NewClient != nil {
		cl = o.NewClient(sess, hasSession, log)
	} else {
		cl = offline.New(hasSession)
	}
	defer cl.Close()

	acct, err := core.New(ctx, core.Options{
		Layout:         l,
		DB:             db,
		Client:         cl,
		Settings:       s,
		Log:            log,
		Now:            o.Now,
		DaemonVersion:  o.Version,
		LibraryVersion: Library(),
	})
	if err != nil {
		return err
	}
	if err := cl.Start(ctx, acct.Handle); err != nil {
		return err
	}
	go acct.RetentionLoop(ctx)

	peer := o.PeerUID
	if peer == nil {
		peer = server.KernelPeerUID
	}
	srv := server.New(acct, log)
	log.Info("listening", "socket", l.Socket())
	if o.Ready != nil {
		o.Ready(acct)
	}
	err = srv.Serve(ctx, ln, os.Getuid(), peer)
	log.Info("stopped")
	return err
}

// DisableCoreDumps sets the core-file size limit to zero (security.md rule 12).
func DisableCoreDumps() error {
	return unix.Setrlimit(unix.RLIMIT_CORE, &unix.Rlimit{Cur: 0, Max: 0})
}

// Listen prepares the runtime directory and binds the socket (socket-protocol.md). The caller
// must hold the lock, which is what entitles it to remove an existing socket.
func Listen(l paths.Layout) (net.Listener, error) {
	dir := l.RuntimeRoot
	if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("cannot create the socket directory: %w", err)
		}
	}
	fi, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if !fi.IsDir() || fi.Mode().Perm() != 0o700 || !ownedByMe(fi) {
		return nil, fmt.Errorf("refusing the socket directory %s: it must be a directory owned by you with mode 0700 (fix: chmod 700 %s)", dir, dir)
	}
	sock := l.Socket()
	if len(sock) > paths.MaxSocketPath() {
		return nil, fmt.Errorf("the socket path %s is %d bytes, longer than this system allows (%d)", sock, len(sock), paths.MaxSocketPath())
	}
	if fi, err := os.Lstat(sock); err == nil {
		if fi.Mode()&fs.ModeSocket == 0 {
			return nil, fmt.Errorf("refusing to replace %s: it is not a socket", sock)
		}
		if err := os.Remove(sock); err != nil {
			return nil, fmt.Errorf("cannot remove the stale socket: %w", err)
		}
	}
	ln, err := net.Listen("unix", sock)
	if err != nil {
		return nil, err
	}
	ln.(*net.UnixListener).SetUnlinkOnClose(false)
	if err := os.Chmod(sock, 0o600); err != nil {
		ln.Close()
		return nil, err
	}
	return ln, nil
}

func ownedByMe(fi fs.FileInfo) bool {
	st, ok := fi.Sys().(*syscall.Stat_t)
	return ok && int(st.Uid) == os.Getuid()
}

// CheckModes refuses any file or directory of the account that group or others can read or
// write, or that another user owns (security.md rule 3).
func CheckModes(l paths.Layout) error {
	check := func(p string, fi fs.FileInfo) error {
		if fi.Mode()&fs.ModeSymlink != 0 {
			return fmt.Errorf("refusing to start: %s is a symbolic link; the account's files must be real files", p)
		}
		if !ownedByMe(fi) {
			return fmt.Errorf("refusing to start: %s is owned by another user", p)
		}
		if fi.Mode().Perm()&0o077 != 0 {
			want := "600"
			if fi.IsDir() {
				want = "700"
			}
			return fmt.Errorf("refusing to start: %s has mode %04o, readable or writable by group or others (fix: chmod %s %s)", p, fi.Mode().Perm(), want, p)
		}
		return nil
	}
	for _, root := range []string{l.ConfigRoot, l.StateRoot} {
		fi, err := os.Lstat(root)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		} else if err != nil {
			return err
		}
		if err := check(root, fi); err != nil {
			return err
		}
	}
	if fi, err := os.Lstat(l.RuntimeRoot); err == nil {
		if err := check(l.RuntimeRoot, fi); err != nil {
			return err
		}
	}
	for _, dir := range []string{l.ConfigDir(), l.StateDir()} {
		err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			if err != nil {
				return err
			}
			fi, err := os.Lstat(p)
			if err != nil {
				return err
			}
			return check(p, fi)
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// Init creates an account's directories and a default settings.json. It fails if the account
// exists.
func Init(account string, getenv paths.Getenv) (paths.Layout, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	l, err := paths.Resolve(account, getenv)
	if err != nil {
		return l, err
	}
	for _, d := range []string{l.ConfigDir(), l.StateDir()} {
		if _, err := os.Lstat(d); err == nil {
			return l, fmt.Errorf("%w: %s already exists", ErrAccountExists, d)
		}
	}
	old := syscall.Umask(0o077)
	defer syscall.Umask(old)
	for _, d := range []string{l.ConfigRoot, l.StateRoot} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return l, err
		}
	}
	for _, d := range []string{l.ConfigDir(), l.StateDir(), l.MediaDir()} {
		if err := os.Mkdir(d, 0o700); err != nil {
			return l, err
		}
	}
	if err := settings.Write(l.SettingsFile(), settings.Default()); err != nil {
		return l, err
	}
	return l, nil
}

// Remove deletes an account's config and state. It refuses while the account's daemon holds the
// lock, and holds the lock itself while deleting so no daemon starts in between.
func Remove(account string, getenv paths.Getenv) (paths.Layout, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	l, err := paths.Resolve(account, getenv)
	if err != nil {
		return l, err
	}
	_, errC := os.Lstat(l.ConfigDir())
	_, errS := os.Lstat(l.StateDir())
	if errors.Is(errC, fs.ErrNotExist) && errors.Is(errS, fs.ErrNotExist) {
		return l, fmt.Errorf("%w %q", ErrNoAccount, account)
	}
	if errS == nil {
		lock, err := lockfile.Acquire(l.LockFile())
		if errors.Is(err, lockfile.ErrHeld) {
			return l, fmt.Errorf("account %q: its daemon is running; stop it first: %w", account, ErrAlreadyRunning)
		} else if err != nil {
			return l, err
		}
		defer lock.Release()
	}
	if err := os.RemoveAll(l.ConfigDir()); err != nil {
		return l, err
	}
	if err := os.RemoveAll(l.StateDir()); err != nil {
		return l, err
	}
	if fi, err := os.Lstat(l.Socket()); err == nil && fi.Mode()&fs.ModeSocket != 0 {
		_ = os.Remove(l.Socket())
	}
	return l, nil
}
