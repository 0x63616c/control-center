package storefake

import (
	"context"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// PutTranscript stores t.
func (f *Store) PutTranscript(_ context.Context, t store.Transcript) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.transcripts[attemptKey{stepKey: stepKeyOf(t.Key), attemptNo: t.AttemptNo}] = t
	return nil
}

// Transcript reads back the transcript for attemptNo of the Step key
// identifies.
func (f *Store) Transcript(_ context.Context, key work.StageKey, attemptNo int) (store.Transcript, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	t, ok := f.transcripts[attemptKey{stepKey: stepKeyOf(key), attemptNo: attemptNo}]
	if !ok {
		return store.Transcript{}, notFoundf("transcript for attempt %d of step %s", attemptNo, key)
	}
	return t, nil
}
