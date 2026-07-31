package storefake

import (
	"context"
	"sort"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

func stepKeyOf(key work.StageKey) stepKey {
	return stepKey{runID: key.RunID, stage: key.Stage, turn: key.Turn}
}

// RecordStep records that a Step happened. Idempotent, matching the real
// store's ON CONFLICT DO NOTHING.
func (f *Store) RecordStep(_ context.Context, key work.StageKey) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.steps[stepKeyOf(key)] = true
	return nil
}

// RecordAttempt records attemptNo of the Step key identifies.
func (f *Store) RecordAttempt(
	_ context.Context, key work.StageKey, attemptNo int,
	model work.Model, usage work.Usage, measured bool, startedAt time.Time,
) (store.Attempt, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a := store.Attempt{
		Key:       key,
		AttemptNo: attemptNo,
		Model:     model,
		Usage:     usage,
		Measured:  measured,
		StartedAt: startedAt,
	}
	f.attempts[attemptKey{stepKey: stepKeyOf(key), attemptNo: attemptNo}] = a
	return a, nil
}

// EndAttempt records how an Attempt ended.
func (f *Store) EndAttempt(_ context.Context, key work.StageKey, attemptNo int, endedAt time.Time, result store.AttemptResult) (store.Attempt, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ak := attemptKey{stepKey: stepKeyOf(key), attemptNo: attemptNo}
	a, ok := f.attempts[ak]
	if !ok {
		return store.Attempt{}, notFoundf("attempt %d of step %s", attemptNo, key)
	}
	a.EndedAt = endedAt
	a.Result = result
	f.attempts[ak] = a
	return a, nil
}

// AttemptsForStep lists every Attempt of the Step key identifies, in order.
func (f *Store) AttemptsForStep(_ context.Context, key work.StageKey) ([]store.Attempt, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	sk := stepKeyOf(key)
	var out []store.Attempt
	for ak, a := range f.attempts {
		if ak.stepKey == sk {
			out = append(out, a)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].AttemptNo < out[j].AttemptNo })
	return out, nil
}

// AttemptsForRun lists every Attempt recorded for runID, across every Step.
func (f *Store) AttemptsForRun(_ context.Context, runID string) ([]store.Attempt, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []store.Attempt
	for ak, a := range f.attempts {
		if ak.runID == runID {
			out = append(out, a)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Key.Stage != out[j].Key.Stage {
			return out[i].Key.Stage < out[j].Key.Stage
		}
		if out[i].Key.Turn != out[j].Key.Turn {
			return out[i].Key.Turn < out[j].Key.Turn
		}
		return out[i].AttemptNo < out[j].AttemptNo
	})
	return out, nil
}
