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
type Resumption int

const (
	// ResumeRun means no usable attempt exists: execute the stage.
	ResumeRun Resumption = iota
	// ResumeAttach means an attempt is still running: wait for it rather than
	// starting a second model invocation against the same sandbox.
	ResumeAttach
	// ResumeDone means an attempt completed: read its stored result.
	ResumeDone
)

// String names the decision for logs.
func (r Resumption) String() string {
	switch r {
	case ResumeRun:
		return "run"
	case ResumeAttach:
		return "attach"
	case ResumeDone:
		return "done"
	default:
		return fmt.Sprintf("Resumption(%d)", int(r))
	}
}

// StageProbe observes what a previous attempt left behind in the sandbox.
//
// It is a seam rather than two direct file reads because the *order* of these
// observations is load-bearing, and order is only testable if the answers can
// be made to change between calls.
type StageProbe interface {
	// ResultExists reports whether the stage's result file is present. Its
	// presence is the completion record.
	ResultExists(ctx context.Context) (bool, error)

	// AttemptRunning reports whether a codex started by a previous attempt is
	// still running in the sandbox.
	//
	// It answers with a bool and not a PID. Nothing records a PID any more —
	// the implementation asks the process table — so a number here would be an
	// artefact of parsing whatever the probe printed, and a caller comparing it
	// to zero would be reading the parse rather than the answer. That is
	// exactly the bug this seam used to have: an unparseable line read as "no
	// attempt is running" and started a second codex against a live one.
	AttemptRunning(ctx context.Context) (bool, error)
}

// Decide reports what to do about a stage attempt.
//
// Activities retry, so a stage can be entered while a previous attempt's codex
// process is still alive in the sandbox. Getting this wrong is expensive in
// both directions: re-running a finished stage burns subscription quota the
// owner also needs interactively, and treating a dead attempt as live hangs the
// stage until its timeout.
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

	alive, err := probe.AttemptRunning(ctx)
	if err != nil {
		return ResumeRun, fmt.Errorf("checking for a running attempt: %w", err)
	}
	if alive {
		return ResumeAttach, nil
	}

	// Nothing is running and nothing had written a result when we looked. An
	// attempt may have finished in the window between those two observations,
	// so look once more before paying for a full re-run.
	done, err = probe.ResultExists(ctx)
	if err != nil {
		return ResumeRun, fmt.Errorf("re-checking for a result after finding a dead attempt: %w", err)
	}
	if done {
		return ResumeDone, nil
	}
	return ResumeRun, nil
}
