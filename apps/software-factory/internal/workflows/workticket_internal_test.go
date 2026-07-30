package workflows

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"go.temporal.io/sdk/workflow"
)

// TestStageFailureDetailNamesASessionFailureByCause is #434's D2 requirement
// that workflow.ErrSessionFailed is handled as its own distinct branch, not
// left as a bare Temporal error string: a run whose sandbox pod died mid-stage
// should read as exactly that on the ticket, not as an opaque activity error
// nobody can diagnose at 3am without already knowing what ErrSessionFailed
// means.
func TestStageFailureDetailNamesASessionFailureByCause(t *testing.T) {
	t.Parallel()

	got := stageFailureDetail(workflow.ErrSessionFailed)
	if !strings.Contains(got, "session failed") {
		t.Errorf("stageFailureDetail(ErrSessionFailed) = %q, want it to name the session failure", got)
	}
	if !strings.Contains(got, "gone") {
		t.Errorf("stageFailureDetail(ErrSessionFailed) = %q, want it to say there is nothing to resume", got)
	}
}

// TestStageFailureDetailIsUnchangedForAnOrdinaryStageFailure proves the
// session-specific branch is additive: every other kind of stage failure
// still reads exactly as it did before Sessions existed.
func TestStageFailureDetailIsUnchangedForAnOrdinaryStageFailure(t *testing.T) {
	t.Parallel()

	err := errors.New("codex exec failed (exit 1): out of quota")
	if got := stageFailureDetail(err); got != err.Error() {
		t.Errorf("stageFailureDetail(%v) = %q, want the error's own message unchanged", err, got)
	}
}

// TestStageFailureDetailSeesThroughWrapping proves the check is errors.Is,
// not equality: a real ExecuteActivity(...).Get failure never returns the
// sentinel bare, so a check that missed a wrapped ErrSessionFailed would
// never fire outside a hand-written test.
func TestStageFailureDetailSeesThroughWrapping(t *testing.T) {
	t.Parallel()

	wrapped := fmt.Errorf("running RunStage for ticket #1: %w", workflow.ErrSessionFailed)
	if got := stageFailureDetail(wrapped); !strings.Contains(got, "session failed") {
		t.Errorf("stageFailureDetail(wrapped ErrSessionFailed) = %q, want it still recognised through the wrapping", got)
	}
}
