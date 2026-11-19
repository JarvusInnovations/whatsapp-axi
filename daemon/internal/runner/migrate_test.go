package runner

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/lockfile"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/paths"
)

func migrateEnv(t *testing.T) (paths.Getenv, string) {
	t.Helper()
	home := t.TempDir()
	env := map[string]string{
		"HOME":            home,
		"XDG_CONFIG_HOME": filepath.Join(home, "config"),
		"XDG_STATE_HOME":  filepath.Join(home, "state"),
		"XDG_RUNTIME_DIR": filepath.Join(home, "run"),
	}
	return func(k string) string { return env[k] }, home
}

// legacyAccount lays an account out directly under the roots, as before the accounts/ level.
func legacyAccount(t *testing.T, home, name string) {
	t.Helper()
	cfg := filepath.Join(home, "config", "whatsapp-axi", name)
	st := filepath.Join(home, "state", "whatsapp-axi", name)
	for _, d := range []string{cfg, filepath.Join(st, "media")} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	os.WriteFile(filepath.Join(cfg, "settings.json"), []byte("{}\n"), 0o600)
	os.WriteFile(filepath.Join(st, "store.db"), []byte("x"), 0o600)
}

func TestInitUsesAccountsDir(t *testing.T) {
	getenv, home := migrateEnv(t)
	l, err := Init("demo", getenv)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(home, "config", "whatsapp-axi", "accounts", "demo", "settings.json"); l.SettingsFile() != want {
		t.Fatalf("settings at %s, want %s", l.SettingsFile(), want)
	}
	if _, err := os.Stat(filepath.Join(home, "state", "whatsapp-axi", "accounts", "demo", "media")); err != nil {
		t.Fatal(err)
	}
}

func TestConfigDirOverride(t *testing.T) {
	getenv, home := migrateEnv(t)
	other := filepath.Join(home, "elsewhere")
	l, err := paths.Resolve("demo", func(k string) string {
		if k == "WHATSAPP_AXI_CONFIG_DIR" {
			return other
		}
		return getenv(k)
	})
	if err != nil {
		t.Fatal(err)
	}
	if l.ConfigDir() != filepath.Join(other, "accounts", "demo") {
		t.Fatalf("config dir %s", l.ConfigDir())
	}
}

func TestReservedNames(t *testing.T) {
	if paths.ValidAccount("accounts") || paths.ValidAccount("config.json") {
		t.Fatal("reserved names accepted")
	}
}

func TestMigrateMovesBothAndKeepsModes(t *testing.T) {
	getenv, home := migrateEnv(t)
	legacyAccount(t, home, "demo")
	moved, err := Migrate("demo", getenv)
	if err != nil || len(moved) != 2 {
		t.Fatalf("moved %v, err %v", moved, err)
	}
	l, _ := paths.Resolve("demo", getenv)
	fi, err := os.Stat(l.SettingsFile())
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("settings %v %v", fi, err)
	}
	if fi, err := os.Stat(l.StateDir()); err != nil || fi.Mode().Perm() != 0o700 {
		t.Fatalf("state dir %v %v", fi, err)
	}
	if _, err := os.Stat(l.LegacyConfigDir()); !os.IsNotExist(err) {
		t.Fatal("old config dir still there")
	}
	// Again: already in place, a no-op.
	moved, err = Migrate("demo", getenv)
	if err != nil || len(moved) != 0 {
		t.Fatalf("second migrate moved %v, err %v", moved, err)
	}
}

func TestMigrateRefusesWhileRunning(t *testing.T) {
	getenv, home := migrateEnv(t)
	legacyAccount(t, home, "demo")
	lock, err := lockfile.Acquire(filepath.Join(home, "state", "whatsapp-axi", "demo", "daemon.lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if _, err := Migrate("demo", getenv); !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("err %v, want already running", err)
	}
	if _, err := os.Stat(filepath.Join(home, "config", "whatsapp-axi", "demo", "settings.json")); err != nil {
		t.Fatal("moved while running")
	}
}

func TestMigrateNoAccount(t *testing.T) {
	getenv, _ := migrateEnv(t)
	if _, err := Migrate("demo", getenv); !errors.Is(err, ErrNoAccount) {
		t.Fatalf("err %v", err)
	}
}
