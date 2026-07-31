package workflows

import (
	"fmt"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// ticketActs, recordingActs and transcriptActs name the second pipeline's
// three activity sets for workflow.ExecuteActivity, the same nil-handle
// pattern acts (loop.go) already uses: Temporal resolves an activity from a
// bound method's name, never by calling it, so a nil receiver makes it
// impossible for workflow code to invoke one directly by accident.
var (
	ticketActs     *activities.TicketActivities
	recordingActs  *activities.RecordingActivities
	transcriptActs *activities.TranscriptRecordingActivities
)

// FactoryWorkTicketInput is one factory Ticket's run.
type FactoryWorkTicketInput struct {
	TicketID store.TicketID

	// Config and Policy are resolved by FactoryDispatcher at the moment the
	// run starts, then fixed — the same "a run finishes under the
	// configuration it began with" rule WorkTicketInput documents.
	Config work.Config
	Policy work.RunPolicy

	// DispatcherID is the workflow to report completion to. Empty means
	// nobody is listening, which is the case for a run started by hand.
	DispatcherID string
}

// FactoryWorkTicketResult is what the run did.
type FactoryWorkTicketResult struct {
	Outcome     work.Outcome
	PullRequest work.PullRequest
	Usage       work.Usage
	Detail      string
}

// FactoryWorkTicket plans, reviews, revises, implements and proposes one
// factory Ticket, then stops. It is WorkTicket's counterpart on the
// Ticket-backed pipeline (ADR-0012's Cutover): same sandbox, session, and
// stage machinery, reused unchanged, but its Ticket comes from Postgres
// rather than a GitHub issue, its progress is recorded into Postgres rather
// than posted as issue comments, and its terminal state is a Ticket
// transition rather than an `auto` label.
//
// It always cleans up: the sandbox is deleted and the Run is recorded ended,
// whether the run succeeded, failed or was cancelled, on the same
// disconnected-context reasoning ticketRun.finish documents.
func FactoryWorkTicket(ctx workflow.Context, in FactoryWorkTicketInput) (FactoryWorkTicketResult, error) {
	if err := validateFactoryWorkTicket(in); err != nil {
		return FactoryWorkTicketResult{}, err
	}

	run := &factoryTicketRun{
		in:    in,
		runID: workflow.GetInfo(ctx).WorkflowExecution.RunID,
	}
	result, err := run.execute(ctx)
	if finishErr := run.finish(ctx, result, err); finishErr != nil && err == nil {
		err = finishErr
	}
	return result, err
}

// validateFactoryWorkTicket refuses an input no run could be made from,
// before anything is created — the same reasoning WorkTicket's validate
// documents.
func validateFactoryWorkTicket(in FactoryWorkTicketInput) error {
	if in.TicketID <= 0 {
		return temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("ticket id %d is not a factory ticket", in.TicketID),
			activities.ErrTypeInvalid, nil)
	}
	if err := in.Policy.Validate(); err != nil {
		return temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("the run policy for ticket %d is unusable: %v", in.TicketID, err),
			activities.ErrTypeInvalid, nil)
	}
	if err := in.Config.Validate(); err != nil {
		return temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("the config for ticket %d is unusable: %v", in.TicketID, err),
			activities.ErrTypeInvalid, nil)
	}
	return nil
}

// factoryTicketRun is one Ticket-backed run's mutable state — ticketRun's
// counterpart, holding what it has created and spent so finish can undo or
// record it.
type factoryTicketRun struct {
	in    FactoryWorkTicketInput
	runID string

	sandbox work.SandboxID
	usage   work.Usage
}

// execute is the pipeline: claim the Ticket, stand up its sandbox, run plan
// once and then the implement/review loop.
func (r *factoryTicketRun) execute(ctx workflow.Context) (FactoryWorkTicketResult, error) {
	control := workflow.WithActivityOptions(ctx, r.controlOptions())

	// This transition IS the claim: TransitionTicketState only succeeds if
	// the Ticket is still Open, so two runs racing to start the same Ticket
	// (the reconcile backstop restarting one FactoryDispatcher believes it
	// lost, alongside a start that already landed) can only have one winner.
	ticket, err := r.transitionTicket(control, store.TicketOpen, store.TicketWorking)
	if err != nil {
		return FactoryWorkTicketResult{Outcome: work.OutcomeFailed}, err
	}

	startedAt := workflow.Now(ctx)
	if err := workflow.ExecuteActivity(control, recordingActs.RecordRunStart, activities.RecordRunStartInput{
		TicketID: r.in.TicketID, RunID: r.runID, StartedAt: startedAt,
	}).Get(ctx, nil); err != nil {
		return FactoryWorkTicketResult{Outcome: work.OutcomeFailed}, err
	}

	create := activities.CreateSandboxInput{
		TicketNumber: int(r.in.TicketID),
		RunID:        r.runID,
		RunTimeout:   r.in.Policy.RunTimeout,
	}
	if err := workflow.ExecuteActivity(control, acts.CreateSandbox, create).Get(ctx, &r.sandbox); err != nil {
		return FactoryWorkTicketResult{Outcome: work.OutcomeFailed}, err
	}
	if err := workflow.ExecuteActivity(control, acts.WaitSandboxReady, r.sandbox).Get(ctx, nil); err != nil {
		return FactoryWorkTicketResult{Outcome: work.OutcomeFailed}, err
	}

	// The checkout must exist before the first stage: codex refuses to run
	// outside a git repository.
	clone := workflow.WithActivityOptions(ctx, r.cloneOptions())
	if err := workflow.ExecuteActivity(clone, acts.CloneRepo, r.sandbox).Get(ctx, nil); err != nil {
		return FactoryWorkTicketResult{Outcome: work.OutcomeFailed}, err
	}

	detail := work.TicketDetail{Ticket: work.Ticket{Number: int(r.in.TicketID), Title: ticket.Title, Body: ticket.Body}}
	prior := make(map[work.Stage][]work.StageOutput, 3)

	sessionCtx, err := r.createSession(ctx)
	if err != nil {
		return FactoryWorkTicketResult{Outcome: work.OutcomeFailed}, err
	}
	defer workflow.CompleteSession(sessionCtx)

	stages := workflow.WithActivityOptions(sessionCtx, r.stageOptions())
	ci := workflow.WithActivityOptions(ctx, r.ciOptions())

	planResult, err := r.runFactoryPlanTurn(ctx, stages, detail, prior)
	if err != nil {
		return FactoryWorkTicketResult{Outcome: work.OutcomeFailed, Usage: r.usage}, err
	}
	prior[work.StagePlan] = append(prior[work.StagePlan], planResult)

	return r.factoryImplementReviewLoop(ctx, control, stages, ci, detail, prior)
}

// finish releases everything the run holds and records how it ended,
// whatever happened to it — the Ticket-backed counterpart of
// ticketRun.finish, on the same disconnected-context reasoning: a cancelled
// run's own context is already dead, and cleanup that only runs on the happy
// path is not cleanup.
//
// Unlike WorkTicket there are no GitHub status comments and no `auto` label
// here: ADR-0012's cutover retires both for the Ticket-backed pipeline, and
// the pull request itself is the only GitHub write left. So finish's two
// jobs are: leave the pull request in the right draft state, and move the
// Ticket to its terminal state.
func (r *factoryTicketRun) finish(ctx workflow.Context, result FactoryWorkTicketResult, runErr error) error {
	log := workflow.GetLogger(ctx)
	ctx, cancel := workflow.NewDisconnectedContext(ctx)
	defer cancel()

	control := workflow.WithActivityOptions(ctx, r.controlOptions())

	if r.sandbox != "" {
		if err := workflow.ExecuteActivity(control, acts.DeleteSandbox, r.sandbox).Get(ctx, nil); err != nil {
			log.Error("deleting the sandbox failed; the dispatcher's sweep will catch it",
				"sandbox", string(r.sandbox), "error", err)
		}
	}

	failure := activities.FailureKindOf(runErr)
	cancelled := temporal.IsCanceledError(runErr)

	outcome := result.Outcome
	if outcome == "" {
		outcome = work.OutcomeFailed
	}

	// A cancelled run decided nothing; leave the Ticket Working rather than
	// guessing a terminal state for it. Known follow-up: TicketState's
	// transition table has no Working -> Open path today, so an operator
	// noticing a stuck cancelled Ticket moves it by hand.
	var terminalErr error
	if !cancelled {
		switch outcome {
		case work.OutcomeBlocked, work.OutcomeExhausted:
			if result.PullRequest.NodeID != "" {
				if err := workflow.ExecuteActivity(control, acts.ConvertPullRequestToDraft, result.PullRequest.NodeID).Get(ctx, nil); err != nil {
					log.Error("converting the pull request to draft failed after every retry",
						"ticket_id", int64(r.in.TicketID), "pull_request", result.PullRequest.Number, "error", err)
				}
			}
			if _, err := r.transitionTicket(control, store.TicketWorking, store.TicketFailed); err != nil {
				log.Error("moving the ticket to failed did not apply; it stays working and will not be re-listed",
					"ticket_id", int64(r.in.TicketID), "error", err)
			}
		case work.OutcomeProposed:
			if err := workflow.ExecuteActivity(control, acts.MarkPullRequestReadyForReview, result.PullRequest.NodeID).Get(ctx, nil); err != nil {
				log.Error("marking the pull request ready for review failed after every retry",
					"ticket_id", int64(r.in.TicketID), "pull_request", result.PullRequest.Number, "error", err)
				terminalErr = fmt.Errorf("marking pull request %s ready for review: %w", result.PullRequest.URL, err)
				break
			}
			if err := workflow.ExecuteActivity(control, acts.EnablePullRequestAutoMerge, result.PullRequest.NodeID).Get(ctx, nil); err != nil {
				log.Error("enabling auto-merge failed after every retry; the pull request still needs a manual merge",
					"ticket_id", int64(r.in.TicketID), "pull_request", result.PullRequest.Number, "error", err)
			}
			if _, err := r.transitionTicket(control, store.TicketWorking, store.TicketReview); err != nil {
				log.Error("moving the ticket to review did not apply",
					"ticket_id", int64(r.in.TicketID), "error", err)
				terminalErr = fmt.Errorf("moving ticket %d to review: %w", r.in.TicketID, err)
			}
		case work.OutcomeFailed:
			if _, err := r.transitionTicket(control, store.TicketWorking, store.TicketFailed); err != nil {
				log.Error("moving the ticket to failed did not apply; it stays working and will not be re-listed",
					"ticket_id", int64(r.in.TicketID), "error", err)
			}
		}
	}

	// RecordRunEnd is not best-effort: ADR-0012 is explicit that recording a
	// Run's end is a Temporal activity that "retries under a policy, and a
	// database outage lasting longer than that policy stalls the Run at
	// that activity and then fails it, loudly" — a Run whose end nobody
	// recorded is a Run nobody can watch. It runs after the Ticket
	// transition (not before) so a database outage cannot leave the Ticket
	// stuck mid-transition while still failing loudly overall.
	if err := workflow.ExecuteActivity(control, recordingActs.RecordRunEnd, activities.RecordRunEndInput{
		RunID: r.runID, EndedAt: workflow.Now(ctx), Outcome: outcome, Failure: failure,
	}).Get(ctx, nil); err != nil && terminalErr == nil {
		terminalErr = fmt.Errorf("recording run %s ended: %w", r.runID, err)
	}

	r.tellDispatcher(ctx, FactoryTicketDone{TicketID: r.in.TicketID, RunID: r.runID})
	return terminalErr
}

// tellDispatcher reports the slot free, best-effort — the dispatcher's own
// reconcile is the backstop, exactly as ticketRun.tellDispatcher documents.
func (r *factoryTicketRun) tellDispatcher(ctx workflow.Context, done FactoryTicketDone) {
	if r.in.DispatcherID == "" {
		return
	}
	if err := workflow.SignalExternalWorkflow(ctx, r.in.DispatcherID, "", SignalFactoryTicketDone, done).Get(ctx, nil); err != nil {
		workflow.GetLogger(ctx).Error("could not tell the factory dispatcher this ticket finished; its reconcile will free the slot instead",
			"dispatcher", r.in.DispatcherID, "error", err)
	}
}

// transitionTicket moves the Ticket from `from` to `to` and returns the
// updated row.
func (r *factoryTicketRun) transitionTicket(control workflow.Context, from, to store.TicketState) (store.Ticket, error) {
	var ticket store.Ticket
	err := workflow.ExecuteActivity(control, ticketActs.TransitionTicketState, r.in.TicketID, from, to).Get(control, &ticket)
	return ticket, err
}

// recordStep records that key's Step happened — best-effort visibility that
// a Step is running, not a correctness requirement: recordAttempt below is
// what a Step's actual cost and result depend on.
func (r *factoryTicketRun) recordStep(ctx workflow.Context, key work.StageKey) {
	control := workflow.WithActivityOptions(ctx, r.controlOptions())
	if err := workflow.ExecuteActivity(control, recordingActs.RecordStep, key).Get(ctx, nil); err != nil {
		workflow.GetLogger(ctx).Error("recording a step failed", "step", key.String(), "error", err)
	}
}

// recordAttempt records one Step's one Attempt, start and end together: by
// the time this is called the stage has already run (or failed to), so both
// halves of the Attempt row are known at once. See RecordAttemptStartInput's
// own doc comment for why Usage and Measured travel on the "start" call
// rather than genuinely preceding execution.
//
// attemptNo is always 1: this run does not yet distinguish a Temporal-level
// activity retry as a separate Attempt row (case 2 in ADR-0012's "why
// Attempt is a row" — the sandbox pod dying mid-stage, a heartbeat timeout).
// Doing so would mean moving stage execution off Temporal's own automatic
// retry and into an explicit retry loop the workflow can observe, which is
// a bigger change than wiring the recording activities #549 already built.
// Every Step this run records still gets exactly the Attempt row the
// console's RunDetail view expects; it just does not yet split a stage's
// own internal retries into more than one.
func (r *factoryTicketRun) recordAttempt(
	ctx workflow.Context, key work.StageKey, model work.Model, startedAt time.Time,
	usage work.Usage, measured bool, result store.AttemptResult,
) {
	const attemptNo = 1
	control := workflow.WithActivityOptions(ctx, r.controlOptions())
	if err := workflow.ExecuteActivity(control, recordingActs.RecordAttemptStart, activities.RecordAttemptStartInput{
		Key: key, AttemptNo: attemptNo, Model: model, Usage: usage, Measured: measured, StartedAt: startedAt,
	}).Get(ctx, nil); err != nil {
		workflow.GetLogger(ctx).Error("recording an attempt's start failed", "step", key.String(), "error", err)
		return
	}
	if err := workflow.ExecuteActivity(control, recordingActs.RecordAttemptEnd, activities.RecordAttemptEndInput{
		Key: key, AttemptNo: attemptNo, EndedAt: workflow.Now(ctx), Result: result,
	}).Get(ctx, nil); err != nil {
		workflow.GetLogger(ctx).Error("recording an attempt's end failed", "step", key.String(), "error", err)
	}
}

// persistTranscript stores one stage's transcript in Postgres — the
// Ticket-backed counterpart of ticketRun.persistTranscript, best-effort for
// the same reason: a transcript is forensics, not the run's actual work, and
// the tokens a stage spent are already spent whether or not its transcript
// makes it home.
//
// Every caller must call recordAttempt for key first (software-factory#602):
// the transcript table's foreign key requires attempt (run_id, stage, turn,
// attempt_no) to already exist, and unlike the store insert itself, that
// constraint violation is not something this best-effort call can route
// around — a transcript this call is never told exists.
func (r *factoryTicketRun) persistTranscript(ctx workflow.Context, key work.StageKey, transcript work.Transcript) {
	control := workflow.WithActivityOptions(ctx, r.controlOptions())
	const attemptNo = 1
	in := activities.PersistTranscriptToStoreInput{Key: key, AttemptNo: attemptNo, Transcript: transcript}
	if err := workflow.ExecuteActivity(control, transcriptActs.PersistTranscriptToStore, in).Get(ctx, nil); err != nil {
		workflow.GetLogger(ctx).Error("could not persist the stage transcript to the store",
			"step", key.String(), "error", err)
	}
}

// createSession claims this run's sandbox pod as a Temporal Session host —
// identical to ticketRun.createSession; see its doc comment for the D1/D2
// reasoning this shares in full.
func (r *factoryTicketRun) createSession(ctx workflow.Context) (workflow.Context, error) {
	sandboxQueue := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		TaskQueue: work.SandboxTaskQueue(r.runID),
	})
	sessionCtx, err := workflow.CreateSession(sandboxQueue, &workflow.SessionOptions{
		ExecutionTimeout: work.SessionExecutionTimeout,
		CreationTimeout:  work.SessionCreationTimeout,
	})
	if err != nil {
		return nil, fmt.Errorf("creating a session for sandbox %s: %w", r.sandbox, err)
	}
	return sessionCtx, nil
}

// controlOptions, cloneOptions, stageOptions and ciOptions mirror ticketRun's
// identically named methods; see those for the reasoning behind each.

func (r *factoryTicketRun) controlOptions() workflow.ActivityOptions {
	return workflow.ActivityOptions{
		StartToCloseTimeout: r.in.Policy.ControlTimeout,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: r.in.Policy.ControlAttempts},
	}
}

func (r *factoryTicketRun) cloneOptions() workflow.ActivityOptions {
	return workflow.ActivityOptions{
		StartToCloseTimeout: r.in.Policy.StageTimeout,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: r.in.Policy.ControlAttempts},
	}
}

func (r *factoryTicketRun) stageOptions() workflow.ActivityOptions {
	return workflow.ActivityOptions{
		StartToCloseTimeout: r.in.Policy.StageTimeout,
		HeartbeatTimeout:    r.in.Policy.StageHeartbeatTimeout,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    work.StageRetryInitialInterval,
			BackoffCoefficient: work.StageRetryBackoffCoefficient,
			MaximumInterval:    work.StageRetryMaximumInterval,
			MaximumAttempts:    r.in.Policy.StageAttempts,
		},
	}
}

func (r *factoryTicketRun) ciOptions() workflow.ActivityOptions {
	return workflow.ActivityOptions{
		StartToCloseTimeout: r.in.Policy.StageTimeout + 5*time.Minute,
		HeartbeatTimeout:    r.in.Policy.StageHeartbeatTimeout,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: r.in.Policy.ControlAttempts},
	}
}
