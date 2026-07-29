package codex

import (
	"errors"
	"strings"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

func TestASuccessfulAttemptIsNotAFailure(t *testing.T) {
	t.Parallel()

	if err := classify(0, outcome{ThreadID: "thr_1"}, nil); err != nil {
		t.Errorf("classify(exit 0, no stream failure) = %v, want nil", err)
	}
}

func TestAnEmptyStdoutFailureIsExplainedFromStderr(t *testing.T) {
	t.Parallel()

	// The single most likely real breakage in this system. codex refuses to
	// start when its refresh token is spent, and it does so before emitting any
	// JSONL at all: exit 1, stdout empty, the cause written only to stderr
	// (verified against rust-v0.145.0 — enforce_login_restrictions eprintln!s
	// and calls process::exit(1)). A classifier reading only the event stream
	// would report a blank, causeless failure for exactly this case.
	err := classify(1, outcome{}, []byte("ERROR: Your session has expired. Please run `codex login`.\n"))
	if err == nil {
		t.Fatal("classify(exit 1) = nil, want an error")
	}
	if !strings.Contains(err.Error(), "session has expired") {
		t.Errorf("classify() = %q, want it to carry the stderr text — nothing else says why", err)
	}
}

func TestAnAuthFailureIsPermanent(t *testing.T) {
	t.Parallel()

	// ADR-0011: an auth failure is dead until a human re-seeds the credential.
	// Retrying it burns the activity's attempts against a wall that will not
	// move, and each attempt is a full re-exploration of the repository.
	for _, stderr := range []string{
		"ERROR: Your session has expired. Please run `codex login`.",
		"error: refresh token is invalid",
		"unauthorized: 401 from the model provider",
	} {
		err := classify(1, outcome{}, []byte(stderr))
		if !errors.Is(err, work.ErrPermanent) {
			t.Errorf("classify(%q) is retryable; an auth failure must not be retried", stderr)
		}
	}
}

func TestARateLimitIsPermanentAndSaysSo(t *testing.T) {
	t.Parallel()

	// Also non-retryable per ADR-0011, but for a different reason and with a
	// different remedy: it trips the dispatcher's breaker rather than stopping
	// the service. The dispatcher can only do that if it can tell the two
	// apart, which is what the second sentinel is for.
	err := classify(1, outcome{Failure: "rate limit reached for gpt-5.6-terra; try again in 4h"}, nil)

	if !errors.Is(err, ErrRateLimited) {
		t.Errorf("classify(rate limit) = %v, want it to satisfy ErrRateLimited so the breaker can trip", err)
	}
	if !errors.Is(err, work.ErrPermanent) {
		t.Error("a rate limit must not be retried into the same wall")
	}
	if errors.Is(err, ErrAuth) {
		t.Error("a rate limit was classified as an auth failure; it would be reported as needing a human re-seed")
	}
}

func TestAnOrdinaryFailureIsRetryable(t *testing.T) {
	t.Parallel()

	// Anything not named above is left retryable, which is Temporal's default.
	// Guessing "permanent" for an unfamiliar message would silently stop
	// retrying transient faults.
	err := classify(1, outcome{Failure: "the model returned a malformed tool call"}, nil)
	if err == nil {
		t.Fatal("classify(exit 1) = nil, want an error")
	}
	if errors.Is(err, work.ErrPermanent) {
		t.Errorf("classify(%v) is permanent; an unrecognised failure must stay retryable", err)
	}
}

func TestAFailedTurnWithAZeroExitIsStillAFailure(t *testing.T) {
	t.Parallel()

	// Belt and braces: the exit code is the primary signal, but a turn.failed
	// event is codex saying the work did not happen. Trusting only the exit
	// code would hand the next stage an empty document as though it were a plan.
	err := classify(0, outcome{Failure: "turn failed: context deadline"}, nil)
	if err == nil {
		t.Error("classify(exit 0, turn.failed) = nil; the stage produced no work and the next stage would be handed it")
	}
}

func TestTheStreamsOwnMessageIsPreferredOverStderr(t *testing.T) {
	t.Parallel()

	// When codex reported a structured failure, that is the cause. stderr at
	// that point is usually warnings and progress noise around it.
	err := classify(1, outcome{Failure: "rate limit reached"}, []byte("warning: something unrelated"))
	if !strings.Contains(err.Error(), "rate limit reached") {
		t.Errorf("classify() = %q, want codex's own failure message", err)
	}
}

func TestAHugeStderrIsTrimmedToItsEnd(t *testing.T) {
	t.Parallel()

	// stderr carries a stage's whole noisy life. The cause is at the end, and
	// the error travels into Temporal history and a GitHub comment, so the
	// whole of it must not.
	noise := strings.Repeat("progress line\n", 5000)
	err := classify(1, outcome{}, []byte(noise+"ERROR: the actual cause"))

	if !strings.Contains(err.Error(), "the actual cause") {
		t.Error("the trimmed stderr dropped the cause at its end")
	}
	if len(err.Error()) > 4096 {
		t.Errorf("the error is %d bytes; it is written to workflow history and an issue comment", len(err.Error()))
	}
}

func TestAFailureWithNothingToSayStillSaysThat(t *testing.T) {
	t.Parallel()

	// A silent non-zero exit is rare and confusing. Saying "no output" beats an
	// error whose message is empty, which reads as a bug in this code.
	err := classify(1, outcome{}, nil)
	if err == nil {
		t.Fatal("classify(exit 1, no output) = nil, want an error")
	}
	if strings.TrimSpace(err.Error()) == "" {
		t.Error("the error message is empty")
	}
	if !strings.Contains(err.Error(), "1") {
		t.Errorf("classify() = %q, want it to name the exit code — it is the only evidence there is", err)
	}
}
