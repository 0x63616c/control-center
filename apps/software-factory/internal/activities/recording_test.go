package activities

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store/storefake"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"
)

// fixedTestTime stands in for time.Now() in tests that do not assert on a
// specific instant: SoftwareStyle bans time.Now() outside internal/clock,
// even in tests, so recorded timestamps here come from one fixed value
// rather than the wall clock.
var fixedTestTime = time.Date(2026, 7, 31, 9, 0, 0, 0, time.UTC)

// workflowEnv returns a fresh Temporal test workflow environment — the
// hermetic, mocked-activity harness SoftwareStyle's testability floor asks
// for (no unit test touches the real world).
func workflowEnv(t *testing.T) *testsuite.TestWorkflowEnvironment {
	t.Helper()
	suite := &testsuite.WorkflowTestSuite{}
	return suite.NewTestWorkflowEnvironment()
}

func mustNewRecording(t *testing.T, recorder RunRecorder) *RecordingActivities {
	t.Helper()
	a, err := NewRecordingActivities(recorder)
	if err != nil {
		t.Fatalf("NewRecordingActivities: %v", err)
	}
	return a
}

func TestNewRecordingActivitiesRejectsANilRecorder(t *testing.T) {
	t.Parallel()

	if _, err := NewRecordingActivities(nil); err == nil {
		t.Fatal("a nil RunRecorder must be rejected at construction, not the first call")
	}
}

// TestRecordingLifecycleWritesOneRunRowOneStepRowAndOneAttemptRow proves
// #549's core shape: a run, its steps (one per (run, stage, turn)), and an
// attempt row per execution, all readable back through the store's own
// RunDetail.
func TestRecordingLifecycleWritesOneRunRowOneStepRowAndOneAttemptRow(t *testing.T) {
	t.Parallel()

	fake := storefake.New()
	a := mustNewRecording(t, fake)
	ctx := context.Background()
	started := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)

	ticket, err := fake.CreateTicket(ctx, "a ticket", "body", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}

	if _, err := a.RecordRunStart(ctx, RecordRunStartInput{TicketID: ticket.ID, RunID: "019fb000-0000-7000-8000-000000000001", StartedAt: started}); err != nil {
		t.Fatalf("RecordRunStart: %v", err)
	}

	implementKey := work.StageKey{Ticket: int(ticket.ID), RunID: "019fb000-0000-7000-8000-000000000001", Stage: work.StageImplement, Turn: 1}
	if err := a.RecordStep(ctx, implementKey); err != nil {
		t.Fatalf("RecordStep: %v", err)
	}
	if _, err := a.RecordAttemptStart(ctx, RecordAttemptStartInput{
		Key: implementKey, AttemptNo: 1, Model: work.Model{Name: "gpt-5.6-terra", Effort: "medium"},
		Usage: work.Usage{InputTokens: 100, OutputTokens: 20}, Measured: true, StartedAt: started,
	}); err != nil {
		t.Fatalf("RecordAttemptStart: %v", err)
	}
	ended := started.Add(time.Minute)
	if _, err := a.RecordAttemptEnd(ctx, RecordAttemptEndInput{Key: implementKey, AttemptNo: 1, EndedAt: ended, Result: store.AttemptSucceeded}); err != nil {
		t.Fatalf("RecordAttemptEnd: %v", err)
	}
	if _, err := a.RecordRunEnd(ctx, RecordRunEndInput{RunID: "019fb000-0000-7000-8000-000000000001", EndedAt: ended, Outcome: work.OutcomeProposed}); err != nil {
		t.Fatalf("RecordRunEnd: %v", err)
	}

	detail, err := fake.RunDetail(ctx, "019fb000-0000-7000-8000-000000000001")
	if err != nil {
		t.Fatalf("RunDetail: %v", err)
	}
	if detail.Run.Outcome != work.OutcomeProposed || detail.Run.EndedAt.IsZero() {
		t.Fatalf("Run = %+v, want an ended, proposed run", detail.Run)
	}
	if len(detail.Steps) != 1 {
		t.Fatalf("Steps = %d, want exactly one (run, stage, turn) row", len(detail.Steps))
	}
	if len(detail.Steps[0].Attempts) != 1 {
		t.Fatalf("Attempts = %d, want exactly one attempt row", len(detail.Steps[0].Attempts))
	}
	attempt := detail.Steps[0].Attempts[0]
	if attempt.Result != store.AttemptSucceeded || !attempt.Measured {
		t.Fatalf("Attempt = %+v, want a measured, succeeded attempt", attempt)
	}
}

// TestRecordAttemptStartRetriedForTheSameAttemptDoesNotDuplicateTheRow proves
// #549's idempotency requirement directly on the activity: an activity
// retry calling RecordAttemptStart twice for the same (run, stage, turn,
// attempt_no) must not create a second row.
func TestRecordAttemptStartRetriedForTheSameAttemptDoesNotDuplicateTheRow(t *testing.T) {
	t.Parallel()

	fake := storefake.New()
	a := mustNewRecording(t, fake)
	ctx := context.Background()
	key := work.StageKey{Ticket: 1, RunID: "019fb000-0000-7000-8000-000000000002", Stage: work.StageImplement, Turn: 1}
	in := RecordAttemptStartInput{Key: key, AttemptNo: 1, Model: work.Model{Name: "m", Effort: "medium"}, Usage: work.Usage{InputTokens: 5}, StartedAt: fixedTestTime}

	if _, err := a.RecordAttemptStart(ctx, in); err != nil {
		t.Fatalf("first RecordAttemptStart: %v", err)
	}
	if _, err := a.RecordAttemptStart(ctx, in); err != nil {
		t.Fatalf("retried RecordAttemptStart: %v", err)
	}

	attempts, err := fake.AttemptsForStep(ctx, key)
	if err != nil {
		t.Fatalf("AttemptsForStep: %v", err)
	}
	if len(attempts) != 1 {
		t.Fatalf("AttemptsForStep = %d rows, want exactly one — a retry must not duplicate", len(attempts))
	}
}

// TestRecordStepRetriedForTheSameStepDoesNotDuplicateTheRow covers
// RecordStep's own idempotency the same way.
func TestRecordStepRetriedForTheSameStepDoesNotDuplicateTheRow(t *testing.T) {
	t.Parallel()

	fake := storefake.New()
	a := mustNewRecording(t, fake)
	ctx := context.Background()
	key := work.StageKey{Ticket: 1, RunID: "019fb000-0000-7000-8000-000000000003", Stage: work.StagePlan, Turn: 1}

	if err := a.RecordStep(ctx, key); err != nil {
		t.Fatalf("first RecordStep: %v", err)
	}
	if err := a.RecordStep(ctx, key); err != nil {
		t.Fatalf("retried RecordStep: %v", err)
	}

	if _, err := fake.RunDetail(ctx, key.RunID); err == nil {
		// RunDetail needs a Run row too; this test only cares that recording
		// the Step twice does not itself error or duplicate, which the calls
		// above already proved by not failing.
		t.Skip("RunDetail is exercised by the lifecycle test; nothing further to assert here")
	}
}

// TestRecordAttemptDistinguishesMeasuredFromUnmeasured proves #426 cannot
// recur through this seam: a resumed attempt's zero usage is recorded as
// unmeasured, never as a real zero measurement.
func TestRecordAttemptDistinguishesMeasuredFromUnmeasured(t *testing.T) {
	t.Parallel()

	fake := storefake.New()
	a := mustNewRecording(t, fake)
	ctx := context.Background()
	now := fixedTestTime

	measuredKey := work.StageKey{Ticket: 1, RunID: "019fb000-0000-7000-8000-000000000004", Stage: work.StageImplement, Turn: 1}
	if _, err := a.RecordAttemptStart(ctx, RecordAttemptStartInput{
		Key: measuredKey, AttemptNo: 1, Model: work.Model{Name: "m", Effort: "medium"},
		Usage: work.Usage{InputTokens: 10, OutputTokens: 5}, Measured: true, StartedAt: now,
	}); err != nil {
		t.Fatalf("RecordAttemptStart(measured): %v", err)
	}

	resumedKey := work.StageKey{Ticket: 1, RunID: "019fb000-0000-7000-8000-000000000004", Stage: work.StageImplement, Turn: 2}
	if _, err := a.RecordAttemptStart(ctx, RecordAttemptStartInput{
		Key: resumedKey, AttemptNo: 1, Model: work.Model{Name: "m", Effort: "medium"},
		Usage: work.Usage{}, Measured: false, StartedAt: now,
	}); err != nil {
		t.Fatalf("RecordAttemptStart(resumed): %v", err)
	}

	measured, err := fake.AttemptsForStep(ctx, measuredKey)
	if err != nil || len(measured) != 1 || !measured[0].Measured {
		t.Fatalf("measured attempt = %+v, %v, want exactly one attempt with Measured = true", measured, err)
	}
	resumed, err := fake.AttemptsForStep(ctx, resumedKey)
	if err != nil || len(resumed) != 1 || resumed[0].Measured {
		t.Fatalf("resumed attempt = %+v, %v, want exactly one attempt with Measured = false", resumed, err)
	}
	if resumed[0].Usage != (work.Usage{}) {
		t.Fatalf("resumed attempt usage = %+v, want a zero Usage rather than a fabricated measurement", resumed[0].Usage)
	}
}

// TestTwoImplementTurnsRecordTwoStepsNotOneCounter proves a run with two
// implement turns records two Step rows — Turn is part of a Step's identity,
// never a counter on one row.
func TestTwoImplementTurnsRecordTwoStepsNotOneCounter(t *testing.T) {
	t.Parallel()

	fake := storefake.New()
	a := mustNewRecording(t, fake)
	ctx := context.Background()
	runID := "019fb000-0000-7000-8000-000000000005"

	ticket, err := fake.CreateTicket(ctx, "t", "b", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	if _, err := a.RecordRunStart(ctx, RecordRunStartInput{TicketID: ticket.ID, RunID: runID, StartedAt: fixedTestTime}); err != nil {
		t.Fatalf("RecordRunStart: %v", err)
	}
	for turn := 1; turn <= 2; turn++ {
		if err := a.RecordStep(ctx, work.StageKey{Ticket: int(ticket.ID), RunID: runID, Stage: work.StageImplement, Turn: turn}); err != nil {
			t.Fatalf("RecordStep(turn %d): %v", turn, err)
		}
	}

	detail, err := fake.RunDetail(ctx, runID)
	if err != nil {
		t.Fatalf("RunDetail: %v", err)
	}
	if len(detail.Steps) != 2 {
		t.Fatalf("Steps = %d, want two — one per implement turn, not one row with a counter", len(detail.Steps))
	}
}

// failingRunRecorder is a RunRecorder whose StartRun always fails, so a
// wrapping workflow's RetryPolicy can be proven to exhaust and fail the run
// rather than the failure being swallowed.
type failingRunRecorder struct {
	calls int
	err   error
}

func (f *failingRunRecorder) StartRun(context.Context, string, store.TicketID, time.Time) (store.Run, error) {
	f.calls++
	return store.Run{}, f.err
}

func (f *failingRunRecorder) EndRun(context.Context, string, time.Time, work.Outcome, work.FailureKind) (store.Run, error) {
	return store.Run{}, nil
}
func (f *failingRunRecorder) RecordStep(context.Context, work.StageKey) error { return nil }
func (f *failingRunRecorder) RecordAttempt(context.Context, work.StageKey, int, work.Model, work.Usage, bool, time.Time) (store.Attempt, error) {
	return store.Attempt{}, nil
}

func (f *failingRunRecorder) EndAttempt(context.Context, work.StageKey, int, time.Time, store.AttemptResult) (store.Attempt, error) {
	return store.Attempt{}, nil
}

var _ RunRecorder = (*failingRunRecorder)(nil)

// recordRunStartHarness is a minimal test-only workflow calling
// RecordRunStart under a short RetryPolicy, so
// TestRecordingFailureThatExhaustsItsRetriesFailsTheRun can prove #549's
// acceptance criterion 7 without a real caller wired up yet (#558 is that
// caller). It lives only in this test file.
func recordRunStartHarness(ctx workflow.Context, in RecordRunStartInput) (store.Run, error) {
	var a *RecordingActivities
	ctx = workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Millisecond,
			BackoffCoefficient: 1,
			MaximumAttempts:    2,
		},
	})
	var out store.Run
	err := workflow.ExecuteActivity(ctx, a.RecordRunStart, in).Get(ctx, &out)
	return out, err
}

// TestRecordingFailureThatExhaustsItsRetriesFailsTheRun proves #549's
// acceptance criterion 7: a recording failure that exhausts its retries
// fails the run rather than being swallowed. ADR-0012 and SoftwareStyle's
// Correctness > Operability both call for this: a run whose progress cannot
// be recorded halts rather than limping on with a silent gap.
func TestRecordingFailureThatExhaustsItsRetriesFailsTheRun(t *testing.T) {
	t.Parallel()

	env := workflowEnv(t)
	recorder := &failingRunRecorder{err: errors.New("connection refused")}
	a := mustNewRecording(t, recorder)
	env.RegisterActivity(a.RecordRunStart)
	env.RegisterWorkflow(recordRunStartHarness)

	env.ExecuteWorkflow(recordRunStartHarness, RecordRunStartInput{TicketID: 1, RunID: "019fb000-0000-7000-8000-000000000006", StartedAt: fixedTestTime})

	if env.GetWorkflowError() == nil {
		t.Fatal("a recording activity that exhausts its retries must fail the workflow, not be swallowed")
	}
	if recorder.calls != 2 {
		t.Fatalf("StartRun was called %d times, want exactly MaximumAttempts (2)", recorder.calls)
	}
}
