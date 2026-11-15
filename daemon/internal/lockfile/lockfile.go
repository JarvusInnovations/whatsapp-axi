// Package lockfile is the single-instance lock on daemon.lock. The kernel releases it when the
// process dies, so a crash never needs manual cleanup.
package lockfile

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// ErrHeld means another process holds the lock.
var ErrHeld = errors.New("already running")

// Lock is a held lock.
type Lock struct{ f *os.File }

// Acquire takes an exclusive, non-blocking lock on path, creating it with mode 0600.
func Acquire(path string) (*Lock, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, unix.EWOULDBLOCK) {
			return nil, ErrHeld
		}
		return nil, err
	}
	return &Lock{f: f}, nil
}

// Release releases the lock.
func (l *Lock) Release() error {
	if l == nil || l.f == nil {
		return nil
	}
	_ = unix.Flock(int(l.f.Fd()), unix.LOCK_UN)
	err := l.f.Close()
	l.f = nil
	return err
}
