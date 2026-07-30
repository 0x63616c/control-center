package local

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// lockTimeout bounds how long a duplicate Temporal delivery can wait for the
// attempt it duplicated. flock deliberately has no timeout of its own.
const lockTimeout = 5 * time.Second

// lockRetryInterval is short compared with a stage, while avoiding a busy loop
// if a duplicate delivery arrives while codex is still running.
const lockRetryInterval = 100 * time.Millisecond

// Locker acquires advisory, per-stage locks on the sandbox's local filesystem.
type Locker struct {
	clock clock.Clock
	ops   lockOps
}

// NewLocker builds a Locker using the sandbox pod's local filesystem.
func NewLocker(clk clock.Clock) *Locker {
	return newLocker(clk, systemLockOps{})
}

func newLocker(clk clock.Clock, ops lockOps) *Locker {
	return &Locker{clock: clk, ops: ops}
}

// Acquire takes path's advisory lock until the returned closer is closed.
func (l *Locker) Acquire(ctx context.Context, path string) (io.Closer, error) {
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("acquiring lock %q: the path must be absolute: %w", path, work.ErrPermanent)
	}
	if err := l.ops.MkdirAll(filepath.Dir(path), dirMode); err != nil {
		return nil, fmt.Errorf("creating the parent directory for lock %q: %w: %w", path, err, work.ErrPermanent)
	}

	deadline := l.clock.Now().Add(lockTimeout)
	for {
		file, err := l.ops.Open(path)
		if err != nil {
			return nil, fmt.Errorf("opening lock %q: %w: %w", path, err, work.ErrPermanent)
		}
		locked, err := l.ops.TryLock(file)
		if err != nil {
			return nil, closeLock(file, fmt.Errorf("locking %q: %w: %w", path, err, work.ErrPermanent))
		}
		if locked {
			return file, nil
		}
		if err := closeLock(file, nil); err != nil {
			return nil, err
		}
		if !l.clock.Now().Before(deadline) {
			return nil, fmt.Errorf("codex lock %q remains held after %s by another attempt of this stage", path, lockTimeout)
		}
		if err := l.clock.Sleep(ctx, lockRetryInterval); err != nil {
			return nil, fmt.Errorf("waiting for codex lock %q: %w", path, err)
		}
	}
}

func closeLock(file io.Closer, prior error) error {
	if err := file.Close(); err != nil {
		if prior != nil {
			return fmt.Errorf("%w; closing the lock file: %w", prior, err)
		}
		return fmt.Errorf("closing the lock file: %w", err)
	}
	return prior
}

type lockOps interface {
	MkdirAll(path string, perm fs.FileMode) error
	Open(path string) (io.Closer, error)
	TryLock(file io.Closer) (bool, error)
}

type systemLockOps struct{}

func (systemLockOps) MkdirAll(path string, perm fs.FileMode) error {
	return os.MkdirAll(path, perm)
}

func (systemLockOps) Open(path string) (io.Closer, error) {
	return os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
}

func (systemLockOps) TryLock(file io.Closer) (bool, error) {
	osFile, ok := file.(*os.File)
	if !ok {
		return false, fmt.Errorf("locking file: unexpected handle %T: %w", file, work.ErrPermanent)
	}
	err := syscall.Flock(int(osFile.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}
