package activities

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"go.temporal.io/sdk/temporal"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// nonRetryable reports what Temporal would make of an error: whether it is an
// ApplicationError, and whether it has been marked as not worth retrying.
func nonRetryable(t *testing.T, err error) (marked, isApplication bool) {
	t.Helper()

	var appErr *temporal.ApplicationError
	if !errors.As(err, &appErr) {
		return false, false
	}
	return appErr.NonRetryable(), true
}

func TestTranslateMarksAPermanentFailureAsNotWorthRetrying(t *testing.T) {
	t.Parallel()

	// The shape a client actually produces: a domain sentinel wrapped in the
	// context of what was being attempted.
	err := fmt.Errorf("minting an installation token: %w", fmt.Errorf("the App is not installed: %w", work.ErrPermanent))

	got := Translate(err)
	marked, isApp := nonRetryable(t, got)
	if !isApp {
		t.Fatalf("Translate returned %T, want a *temporal.ApplicationError", got)
	}
	if !marked {
		t.Error("a permanent failure was left retryable; Temporal would pay for attempts that cannot succeed")
	}
}

func TestTranslateKeepsTheDiagnosisIntact(t *testing.T) {
	t.Parallel()

	cause := fmt.Errorf("the App is not installed on this repository: %w", work.ErrPermanent)
	got := Translate(fmt.Errorf("minting an installation token: %w", cause))

	// The operator reads the failure in Temporal's UI, and the sentinel is the
	// least interesting part of it. Losing the wrapping leaves "permanent
	// failure" with no statement of what failed.
	if msg := got.Error(); !strings.Contains(msg, "minting an installation token") || !strings.Contains(msg, "not installed") {
		t.Errorf("translated message %q dropped the context it was wrapped in", msg)
	}
	// And the domain sentinel survives, so code between the failure and the
	// activity boundary can still recognise its own error.
	if !errors.Is(got, work.ErrPermanent) {
		t.Error("translation severed the cause; errors.Is(err, work.ErrPermanent) no longer holds")
	}
}

func TestTranslateNamesOneStableErrorType(t *testing.T) {
	t.Parallel()

	var appErr *temporal.ApplicationError
	if !errors.As(Translate(fmt.Errorf("wrapped: %w", work.ErrPermanent)), &appErr) {
		t.Fatal("Translate did not produce an ApplicationError")
	}
	// Retry policies name error types as strings, so this one is a published
	// identifier: renaming it silently disarms every policy that lists it.
	if appErr.Type() != ErrorTypePermanent {
		t.Errorf("error type = %q, want %q", appErr.Type(), ErrorTypePermanent)
	}
}

func TestTranslateLeavesEverythingElseRetryable(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		err  error
	}{
		{name: "no error at all", err: nil},
		{name: "a transient GitHub failure", err: errors.New("502 from api.github.com")},
		{name: "a stored object changed under a write", err: fmt.Errorf("saving: %w", work.ErrVersionConflict)},
		{name: "a file missing from a sandbox", err: fmt.Errorf("reading the result: %w", work.ErrFileNotFound)},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got := Translate(tc.err)
			// Retryable is Temporal's default, and the default is reached by
			// handing the error back untouched. Anything else here would be a
			// second taxonomy sitting beside Temporal's own.
			if !errors.Is(got, tc.err) {
				t.Errorf("Translate(%v) = %v, want the error unchanged", tc.err, got)
			}
			if marked, _ := nonRetryable(t, got); marked {
				t.Errorf("Translate(%v) marked a retryable failure as permanent", tc.err)
			}
		})
	}
}

func TestTranslateLeavesCancellationAlone(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		err  error
	}{
		{name: "the activity was cancelled", err: context.Canceled},
		{name: "the activity ran out of time", err: context.DeadlineExceeded},
		{name: "cancellation reported through a permanent wrapper", err: fmt.Errorf("%w: %w", work.ErrPermanent, context.Canceled)},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			// A drained worker cancels its activities. Turning that into an
			// application failure would make a clean SIGTERM look like a
			// ticket that failed permanently, and the ticket would not be
			// picked up again.
			got := Translate(tc.err)
			if marked, _ := nonRetryable(t, got); marked {
				t.Errorf("Translate(%v) turned cancellation into a permanent application failure", tc.err)
			}
			if !errors.Is(got, tc.err) {
				t.Errorf("Translate(%v) = %v, want the error unchanged", tc.err, got)
			}
		})
	}
}
