package codex

import (
	"context"
	"fmt"
	"io/fs"
	"strings"
)

// RolloutProbe checks whether Codex's local rollout state for a provider
// thread survived on this Run Worker generation.
type RolloutProbe struct{ root fs.FS }

// NewRolloutProbe builds a provider-state probe over CODEX_HOME.
func NewRolloutProbe(root fs.FS) (*RolloutProbe, error) {
	if root == nil {
		return nil, fmt.Errorf("constructing Codex rollout probe: filesystem is required")
	}
	return &RolloutProbe{root: root}, nil
}

// Available never treats unreadable state as absence: a cheap observation may
// retry, while a false absence permanently closes an authorized Attempt.
func (p *RolloutProbe) Available(ctx context.Context, threadID string) (bool, error) {
	if strings.TrimSpace(threadID) == "" {
		return false, fmt.Errorf("checking Codex rollout state: thread ID is required")
	}
	found := false
	err := fs.WalkDir(p.root, ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if !entry.IsDir() && strings.Contains(entry.Name(), threadID) {
			found = true
			return fs.SkipAll
		}
		return nil
	})
	if err != nil {
		return false, fmt.Errorf("checking Codex rollout state for %s: %w", threadID, err)
	}
	return found, nil
}
