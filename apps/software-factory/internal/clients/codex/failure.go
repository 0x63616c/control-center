package codex

import (
	"fmt"
	"strings"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// The failure sentinels — and a decision about them that is now owed.
//
// Both exist so the dispatcher can tell "wait, then carry on" from "stop and
// fetch a human". As of D1 (#368) it cannot, and this is no longer hypothetical:
// activities.Translate is the one place a domain error becomes a Temporal one,
// and it maps EVERY permanent error onto the single type
// activities.ErrorTypePermanent. Nothing distinguishes a rate limit from an
// auth failure on the far side.
//
// Nor can the dispatcher recover the difference itself. Temporal serialises an
// activity's error into an ApplicationError carrying a type string and a
// message; the messages survive, but the reconstructed values are
// *ApplicationError, not these sentinels, so errors.Is(err, ErrRateLimited) in
// workflow code is false however carefully the error was wrapped here.
//
// So one of two things should happen, and leaving it undecided is the only
// wrong answer: either Translate grows a distinct type per sentinel and the
// dispatcher switches on the type, or one of these is deleted rather than left
// reading as load-bearing when nothing can read it. The tests below pin only
// that both are permanent and that a rate limit is not an auth failure — true
// either way, so they will not make this choice for anyone.
//
// Where to assert it, for whoever does decide, because the two obvious places
// disagree and only one of them is honest. A DIRECT call to an activity
// function proves nothing: nothing is serialised, the Go chain is intact, and
// errors.Is SUCCEEDS — a green test for a thing that does not hold in
// production. TestActivityEnvironment does serialise, so it is the boundary and
// it is the right place to assert. Measured against this tree, with an activity
// returning Translate(fmt.Errorf("scripted: %w", ErrRateLimited)):
//
//	direct call               errors.Is = true    *ApplicationError
//	TestActivityEnvironment   errors.Is = false   *ActivityError
//
// The same measurement shows the recommended mechanism already works: errors.As
// finds an *ApplicationError carrying (type: PermanentFailure, retryable:
// false). A dispatcher can switch on that type the moment Translate gives each
// sentinel one of its own.
//
// Translate's own doc says "errors.Is still finds the sentinel on the way out",
// which is true of the value it returns in-process and not of what a workflow
// receives.
var (
	// ErrRateLimited reports that the plan's rate limit, not the work, ended
	// this stage.
	//
	// It is a second sentinel beside work.ErrPermanent rather than a rival
	// retry taxonomy, and the distinction matters: both are non-retryable, but
	// a rate limit trips the dispatcher's breaker and clears on its own, while
	// everything else permanent needs a human. Wrapping alone could not express
	// that — by the time an error reaches the dispatcher, "do not retry" and
	// "stop starting new work for a while" are different instructions.
	ErrRateLimited = fmt.Errorf("the model provider's rate limit was reached: %w", work.ErrPermanent)

	// ErrAuth reports that codex could not authenticate at all.
	//
	// ADR-0011: this is the one failure that stops the service rather than a
	// ticket. The refresh token is single-use and rotating, and once it is
	// spent or revoked no amount of retrying re-mints it — recovery is a human
	// running codex login and re-seeding.
	ErrAuth = fmt.Errorf("codex could not authenticate: %w", work.ErrPermanent)
)

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
