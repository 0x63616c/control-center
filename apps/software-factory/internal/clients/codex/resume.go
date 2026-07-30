// Package codex runs pipeline stages by invoking the codex CLI inside a
// sandbox, and is the only place this service shells out. It seals the CLI's
// argv, its JSONL event stream and its on-disk conventions behind domain types.
package codex

import (
	"context"
	"fmt"
)

// Resumption is what a stage attempt should do about the state a previous
// attempt left behind.
//
// Before step 3 (#434) a third value, ResumeAttach, existed: an attempt could
// find a previous one still running *in a different process* (the worker had
// restarted; the sandbox's codex had not) and wait on it rather than starting
// a second one. Sessions remove that possibility by construction — a stage now
// runs as a local subprocess inside the very activity that is deciding this,
// so "a previous attempt is still running, elsewhere" cannot arise: either
// this call is that attempt, or no attempt is running. See ADR-0011 and #434's
// spec ("The reattach path really is dead code the moment Sessions land").
type Resumption int

const (
	// ResumeRun means no usable attempt exists: execute the stage.
	ResumeRun Resumption = iota
	// ResumeDone means an attempt completed: read its stored result.
	ResumeDone
)

// String names the decision for logs.
func (r Resumption) String() string {
	switch r {
	case ResumeRun:
		return "run"
	case ResumeDone:
		return "done"
	default:
		return fmt.Sprintf("Resumption(%d)", int(r))
	}
}

// StageProbe observes what a previous attempt left behind in the sandbox.
//
// It is a seam rather than a direct file read for the same reason every other
// external edge in this package is: a test hands it a fake rather than
// reaching a real sandbox. Only one observation remains post-#434 — see
// Resumption's doc comment for why AttemptRunning is gone rather than merely
// unused.
type StageProbe interface {
	// ResultExists reports whether the stage's result file is present. Its
	// presence is the completion record, and — because retries stay within one
	// session and one process now — the only question left to ask about a
	// previous attempt at all: did it already write one.
	ResultExists(ctx context.Context) (bool, error)
}

// Decide reports what to do about a stage attempt.
//
// Activities retry, and a retry within the same session can find its own
// previous attempt already finished. Getting this wrong is expensive in one
// direction only now: re-running a finished stage burns subscription quota the
// owner also needs interactively.
//
// It never guesses. If the sandbox cannot be read, it returns an error rather
// than defaulting to a re-run — a wrong "run" costs real money, and a caller
// that sees an error can retry the cheap observation.
func Decide(ctx context.Context, probe StageProbe) (Resumption, error) {
	done, err := probe.ResultExists(ctx)
	if err != nil {
		return ResumeRun, fmt.Errorf("checking for a completed result: %w", err)
	}
	if done {
		return ResumeDone, nil
	}
	return ResumeRun, nil
}
