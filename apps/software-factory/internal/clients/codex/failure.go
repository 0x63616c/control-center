package codex

import (
	"fmt"
	"strings"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// ErrRateLimited reports that the plan's rate limit, not the work, ended this
// stage.
//
// It is a second sentinel beside work.ErrPermanent rather than a rival retry
// taxonomy, and the distinction matters: both are non-retryable, but a rate
// limit trips the dispatcher's breaker and clears on its own, while everything
// else permanent needs a human. Wrapping alone could not express that — by the
// time an error reaches the dispatcher, "do not retry" and "stop starting new
// work for a while" are different instructions.
var ErrRateLimited = fmt.Errorf("the model provider's rate limit was reached: %w", work.ErrPermanent)

// ErrAuth reports that codex could not authenticate at all.
//
// ADR-0011: this is the one failure that stops the service rather than a
// ticket. The refresh token is single-use and rotating, and once it is spent
// or revoked no amount of retrying re-mints it — recovery is a human running
// codex login and re-seeding.
var ErrAuth = fmt.Errorf("codex could not authenticate: %w", work.ErrPermanent)

// A constraint on whoever wires these into an activity (D1, #340).
//
// Both sentinels exist so the dispatcher can tell "wait, then carry on" from
// "stop and fetch a human". Today it cannot, and not because of anything in
// this file: there is no activity boundary yet. When one lands, Temporal
// serialises an activity's error into an ApplicationError carrying a Type
// string and a message — the Go error chain does NOT cross into workflow code.
// errors.Is(err, ErrRateLimited) in the dispatcher will be false however
// carefully the error was wrapped here.
//
// So these two buy nothing unless that translation maps each onto a DISTINCT
// ApplicationError Type, and the dispatcher switches on the Type. If it maps
// everything permanent onto one Type, delete one of these rather than leave a
// distinction that reads as load-bearing and is not.

// stderrLimit is how much of stderr an error may carry. The error is written to
// Temporal history and quoted into a GitHub comment, and neither is the place
// for a stage's whole log — the transcript already holds that.
const stderrLimit = 2000

// Phrases that classify a failure. They are matched against codex's own text,
// which is the only signal there is: `codex exec --json` has no structured
// rate-limit or auth event, so ADR-0011 calls this detection heuristic and
// means it.
//
// The list is deliberately short. A phrase that matched too widely would mark
// an ordinary, retryable failure as permanent and stop a stage that would have
// succeeded on its second attempt, which is a worse and much quieter failure
// than retrying something that was never going to work.
var (
	rateLimitPhrases = []string{
		"rate limit",
		"rate_limit",
		"429",
		"quota exceeded",
		"usage limit",
	}
	authPhrases = []string{
		"session has expired",
		"refresh token",
		"unauthorized",
		"401",
		"not logged in",
		"codex login",
		"invalid_grant",
	}
)

// classify turns what an attempt produced into an error, or nil if it worked.
//
// Both inputs are needed, and this is the reason the caller must capture
// stderr. codex refuses to start when its credential is spent, and it does so
// before emitting a single JSONL event: exit 1, stdout empty, the cause on
// stderr only (verified against rust-v0.145.0 — enforce_login_restrictions
// prints to stderr and exits 1). Reading the event stream alone would report
// the most likely real breakage in this system as a blank failure with no
// cause, at 3am, to somebody who has to guess.
func classify(exitCode int, stream outcome, stderr []byte) error {
	if exitCode == 0 && stream.Failure == "" {
		return nil
	}

	// codex's own message when it managed to produce one; the tail of stderr
	// when it did not. The stream's message is structured and specific, and by
	// the time one exists stderr is mostly the noise around it.
	cause := stream.Failure
	if cause == "" {
		cause = tail(string(stderr), stderrLimit)
	}
	if strings.TrimSpace(cause) == "" {
		cause = "it wrote nothing to stdout or stderr"
	}

	err := fmt.Errorf("codex exec failed (exit %d): %s", exitCode, cause)
	switch {
	case containsAny(cause, rateLimitPhrases):
		return fmt.Errorf("%w: %w", ErrRateLimited, err)
	case containsAny(cause, authPhrases):
		return fmt.Errorf("%w: %w", ErrAuth, err)
	default:
		// Unrecognised, and therefore retryable — Temporal's default. Guessing
		// permanent here would silently stop retrying transient faults.
		return err
	}
}

// containsAny reports whether text holds any of these phrases, ignoring case.
func containsAny(text string, phrases []string) bool {
	lowered := strings.ToLower(text)
	for _, phrase := range phrases {
		if strings.Contains(lowered, phrase) {
			return true
		}
	}
	return false
}

// tail returns the last limit bytes of s, which is where a cause is. A process
// that failed says why last; everything before it is what it was doing at the
// time.
func tail(s string, limit int) string {
	s = strings.TrimSpace(s)
	if len(s) <= limit {
		return s
	}
	trimmed := s[len(s)-limit:]
	// Start at a line boundary when there is one, so the message does not open
	// mid-word.
	if _, after, found := strings.Cut(trimmed, "\n"); found {
		trimmed = after
	}
	return "…" + trimmed
}
