// Package paths resolves an account's files from the XDG directories, as fixed in
// specs/architecture.md and specs/socket-protocol.md.
package paths

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

// App is the directory name used under every XDG root.
const App = "whatsapp-axi"

var accountRe = regexp.MustCompile(`^[a-z][a-z0-9-]{0,23}$`)

// Reserved names an account may not take: the tool's own entries at the roots.
var reserved = map[string]bool{"accounts": true, "config.json": true}

// ValidAccount reports whether name is a valid account name.
func ValidAccount(name string) bool { return accountRe.MatchString(name) && !reserved[name] }

// ErrBadAccount is returned for a name that does not match the account-name rule.
var ErrBadAccount = errors.New("account names match ^[a-z][a-z0-9-]{0,23}$ and are not accounts")

// Layout is every path of one account.
type Layout struct {
	Account     string
	ConfigRoot  string // <config>
	StateRoot   string // <state>
	DataRoot    string // <data>
	RuntimeRoot string // <runtime>
}

// AccountsConfig and AccountsState hold one directory per account (specs/conventions.md "Storage").
func (l Layout) AccountsConfig() string { return filepath.Join(l.ConfigRoot, "accounts") }
func (l Layout) AccountsState() string  { return filepath.Join(l.StateRoot, "accounts") }

func (l Layout) ConfigDir() string    { return filepath.Join(l.AccountsConfig(), l.Account) }
func (l Layout) SettingsFile() string { return filepath.Join(l.ConfigDir(), "settings.json") }
func (l Layout) StateDir() string     { return filepath.Join(l.AccountsState(), l.Account) }

// LegacyConfigDir and LegacyStateDir are where an account stood before the accounts/ level.
func (l Layout) LegacyConfigDir() string { return filepath.Join(l.ConfigRoot, l.Account) }
func (l Layout) LegacyStateDir() string  { return filepath.Join(l.StateRoot, l.Account) }
func (l Layout) SessionDB() string       { return filepath.Join(l.StateDir(), "session.db") }
func (l Layout) StoreDB() string         { return filepath.Join(l.StateDir(), "store.db") }
func (l Layout) MediaDir() string        { return filepath.Join(l.StateDir(), "media") }
func (l Layout) LockFile() string        { return filepath.Join(l.StateDir(), "daemon.lock") }
func (l Layout) Socket() string          { return filepath.Join(l.RuntimeRoot, l.Account+".sock") }
func (l Layout) DaemonBinary() string    { return filepath.Join(l.DataRoot, "bin", "whatsapp-axid") }

// Getenv is the environment lookup used for resolution; os.Getenv in production.
type Getenv func(string) string

// xdg returns $name when it is set to an absolute path, else $HOME/<fallback>.
// Relative values are ignored, as the XDG Base Directory specification requires.
func xdg(getenv Getenv, name, fallback string) (string, error) {
	if v := getenv(name); v != "" && filepath.IsAbs(v) {
		return v, nil
	}
	home := getenv("HOME")
	if home == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("cannot find the home directory: %w", err)
		}
		home = h
	}
	return filepath.Join(home, fallback), nil
}

// Roots resolves the per-user roots without an account.
func Roots(getenv Getenv) (Layout, error) {
	var l Layout
	var err error
	if l.ConfigRoot, err = xdg(getenv, "XDG_CONFIG_HOME", ".config"); err != nil {
		return l, err
	}
	if l.StateRoot, err = xdg(getenv, "XDG_STATE_HOME", filepath.Join(".local", "state")); err != nil {
		return l, err
	}
	if l.DataRoot, err = xdg(getenv, "XDG_DATA_HOME", filepath.Join(".local", "share")); err != nil {
		return l, err
	}
	l.ConfigRoot = filepath.Join(l.ConfigRoot, App)
	// WHATSAPP_AXI_CONFIG_DIR, when set to an absolute path, is the config root itself.
	if v := strings.TrimSpace(getenv("WHATSAPP_AXI_CONFIG_DIR")); v != "" && filepath.IsAbs(v) {
		l.ConfigRoot = v
	}
	l.StateRoot = filepath.Join(l.StateRoot, App)
	l.DataRoot = filepath.Join(l.DataRoot, App)
	l.RuntimeRoot = runtimeRoot(getenv, l.StateRoot)
	return l, nil
}

// Resolve returns the layout of an account.
func Resolve(account string, getenv Getenv) (Layout, error) {
	if !ValidAccount(account) {
		return Layout{}, fmt.Errorf("bad account name %q: %w", account, ErrBadAccount)
	}
	l, err := Roots(getenv)
	if err != nil {
		return l, err
	}
	l.Account = account
	return l, nil
}

// runtimeRoot applies the three-step rule of specs/socket-protocol.md.
func runtimeRoot(getenv Getenv, stateRoot string) string {
	if v := getenv("XDG_RUNTIME_DIR"); v != "" && filepath.IsAbs(v) {
		return filepath.Join(v, App)
	}
	uid := os.Getuid()
	run := filepath.Join("/run/user", strconv.Itoa(uid))
	if fi, err := os.Stat(run); err == nil && fi.IsDir() && fi.Mode().Perm() == 0o700 {
		if st, ok := fi.Sys().(*syscall.Stat_t); ok && int(st.Uid) == uid {
			return filepath.Join(run, App)
		}
	}
	return filepath.Join(stateRoot, "run")
}

// MaxSocketPath is the longest socket path the platform accepts (sun_path minus the NUL).
func MaxSocketPath() int {
	if runtime.GOOS == "linux" {
		return 107
	}
	return 103
}
