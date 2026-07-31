package activities

import (
	"context"
	"fmt"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// RunRecorder is the store surface RecordingActivities needs to project a
// Run's whole life — start, its Steps, their Attempts, and its end — into
// ADR-0012's Postgres store. It is satisfied by *store.Store and, for tests,
// by storefake's fake, so no pgx or sqlc type crosses into this package
// (SoftwareStyle: no leaky abstractions).
type RunRecorder interface {
	store.RunStarter
	store.RunEnder
	store.StepRecorder
	store.AttemptRecorder
	store.AttemptEnder
}

// RecordingActivities projects a Ticket-driven Run into ADR-0012's Postgres
// store: one row for the Run, one for each Step, one for each Attempt,
// written as the run happens rather than reconstructed after the fact (ADR
// "The write path").
//
// It is deliberately its own type, not new methods on Activities. Activities
// is the seam the CURRENTLY RUNNING, GitHub-issue-driven WorkTicket and
// Dispatcher workflows call, and ADR-0012's Cutover section is explicit:
// "the existing pair is not modified." The store's run.ticket_id is a NOT
// NULL foreign key to a factory-owned Ticket row, and a GitHub issue has no
// such row behind it — ADR-0012 separately, and just as explicitly, rules
// out ever bridging one ("A GitHub Issue → Ticket bridge of any kind" is
// listed under Deliberately not decided). So nothing in the running pipeline
// may call these methods: there is no Ticket a GitHub-driven Run could
// legally record itself against.
//
// #558 ("a second dispatcher and workflow that work Tickets from Postgres")
// is this type's one intended caller: its ticket-driven workflow runs
// against real Tickets, for which every call here is always satisfiable, and
// registering this type on the worker is that ticket's job, alongside its
// own workflow and dispatcher. Until then, RecordingActivities exists, is
// fully tested against both storefake and a real database, and is on no
// task queue — see this repository's software-factory#549 and the ADR-0012
// amendment issue it links for why recording could not be wired into
// today's pipeline instead.
type RecordingActivities struct {
	store RunRecorder
}

// NewRecordingActivities builds the recording activity set over recorder.
func NewRecordingActivities(recorder RunRecorder) (*RecordingActivities, error) {
	if recorder == nil {
		return nil, fmt.Errorf("recording activities: a RunRecorder is required")
	}
	return &RecordingActivities{store: recorder}, nil
}

// RecordRunStartInput names the Run to start and the Ticket it belongs to.
type RecordRunStartInput struct {
	TicketID  store.TicketID
	RunID     string
	StartedAt time.Time
}

// RecordRunStart records that a new Run has begun against a Ticket. It is
// the first write of a Run's life; every Step and Attempt recorded after it
// references this row by RunID.
func (a *RecordingActivities) RecordRunStart(ctx context.Context, in RecordRunStartInput) (store.Run, error) {
	run, err := a.store.StartRun(ctx, in.RunID, in.TicketID, in.StartedAt)
	if err != nil {
		return store.Run{}, fail(ctx, fmt.Sprintf("starting run %s for ticket %d", in.RunID, in.TicketID), err)
	}
	return run, nil
}

// RecordRunEndInput names the Run to end, how it ended, and when.
type RecordRunEndInput struct {
	RunID   string
	EndedAt time.Time
	Outcome work.Outcome
	Failure work.FailureKind
}

// RecordRunEnd records how and when a Run ended.
func (a *RecordingActivities) RecordRunEnd(ctx context.Context, in RecordRunEndInput) (store.Run, error) {
	run, err := a.store.EndRun(ctx, in.RunID, in.EndedAt, in.Outcome, in.Failure)
	if err != nil {
		return store.Run{}, fail(ctx, fmt.Sprintf("ending run %s", in.RunID), err)
	}
	return run, nil
}

// RecordStep records that key's Step happened. Idempotent: a retried call
// upserts the same (run, stage, turn) row rather than duplicating it — see
// store.StepRecorder.
func (a *RecordingActivities) RecordStep(ctx context.Context, key work.StageKey) error {
	if err := a.store.RecordStep(ctx, key); err != nil {
		return fail(ctx, fmt.Sprintf("recording step %s", key), err)
	}
	return nil
}

// RecordAttemptStartInput names the Attempt to record, what it ran on, what
// it has cost so far, and whether that cost was actually measured.
type RecordAttemptStartInput struct {
	Key       work.StageKey
	AttemptNo int
	Model     work.Model
	Usage     work.Usage

	// Measured reports whether Usage was observed rather than defaulted. Carry
	// work.StageOutput's own UsageMeasured here unchanged — do not re-derive
	// it. A resumed attempt reports false with a zero Usage; recording it as
	// true would reintroduce #426, a resumed stage's zero spend rendered as a
	// real measurement.
	Measured  bool
	StartedAt time.Time
}

// RecordAttemptStart records a new Attempt of a Step.
func (a *RecordingActivities) RecordAttemptStart(ctx context.Context, in RecordAttemptStartInput) (store.Attempt, error) {
	attempt, err := a.store.RecordAttempt(ctx, in.Key, in.AttemptNo, in.Model, in.Usage, in.Measured, in.StartedAt)
	if err != nil {
		return store.Attempt{}, fail(ctx, fmt.Sprintf("recording attempt %d of %s", in.AttemptNo, in.Key), err)
	}
	return attempt, nil
}

// RecordAttemptEndInput names the Attempt to close out, when, and how it
// ended.
type RecordAttemptEndInput struct {
	Key       work.StageKey
	AttemptNo int
	EndedAt   time.Time
	Result    store.AttemptResult
}

// RecordAttemptEnd records how and when an Attempt ended.
func (a *RecordingActivities) RecordAttemptEnd(ctx context.Context, in RecordAttemptEndInput) (store.Attempt, error) {
	attempt, err := a.store.EndAttempt(ctx, in.Key, in.AttemptNo, in.EndedAt, in.Result)
	if err != nil {
		return store.Attempt{}, fail(ctx, fmt.Sprintf("ending attempt %d of %s", in.AttemptNo, in.Key), err)
	}
	return attempt, nil
}
