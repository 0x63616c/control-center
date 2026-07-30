package codex

import (
	"context"
	"fmt"
	"io"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// NewUnavailableLocker fails closed when a runner is composed outside a
// sandbox. Only the sandbox has the local filesystem required for this guard.
func NewUnavailableLocker(reason string) StageLocker {
	return unavailableLocker{reason: reason}
}

type unavailableLocker struct {
	reason string
}

func (l unavailableLocker) Acquire(_ context.Context, path string) (io.Closer, error) {
	return nil, fmt.Errorf("cannot acquire required stage lock at %s: %s: %w", path, l.reason, work.ErrPermanent)
}
