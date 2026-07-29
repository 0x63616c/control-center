package activities

import (
	"context"
	"errors"

	"go.temporal.io/sdk/temporal"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// ErrorTypePermanent is the Temporal error type a permanent domain failure
// arrives as.
//
// It is a published identifier, not a message: a RetryPolicy names error types
// as strings in NonRetryableErrorTypes, and a workflow that lists this one is
// disarmed silently if it is renamed here. One name, defined once, referenced
// by every policy that cares.
const ErrorTypePermanent = "PermanentFailure"

// Translate converts a domain error into Temporal's error taxonomy, and is the
// only place in this service that does.
//
// Call it on the way out of every activity in this package. work.ErrPermanent
// carries the single bit Temporal needs — "a retry cannot fix this" — precisely
// so that no client has to import the Temporal SDK to say it; this is where
// that bit is spent. Everything else is handed back untouched, because
// retryable is Temporal's default and reaching a default by doing nothing is
// what keeps this from becoming a second taxonomy beside Temporal's own.
//
// Cancellation is deliberately exempt, including a cancellation that arrived
// wrapped in a permanent error. A draining worker cancels its activities on
// SIGTERM, and a clean drain reported as a permanent application failure is a
// ticket that fails on every deploy and is never picked up again.
func Translate(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	if !errors.Is(err, work.ErrPermanent) {
		return err
	}
	// The message is the whole wrapped chain, not the sentinel: what an
	// operator reads in Temporal's UI has to say what failed, and "permanent
	// failure" on its own says only that something did. The cause is carried
	// too, so errors.Is still finds the sentinel on the way out.
	return temporal.NewNonRetryableApplicationError(err.Error(), ErrorTypePermanent, err)
}
