// Package workflows holds the two workflows this service runs: a dispatcher
// that decides what is worked, and a WorkTicket run per ticket that works it.
//
// Everything here is replayed. Workflow code uses workflow.Now, workflow.Sleep
// and workflow.Go, never time.Now, time.Sleep or a naked go statement, and it
// performs no I/O of its own — every effect is an activity. A violation does
// not fail the build; it corrupts a run days later, which is why the linter's
// rules on this directory are wider than anywhere else in the module.
package workflows

import (
	"errors"
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// acts names the activity methods for workflow.ExecuteActivity. It is always
// nil: Temporal resolves an activity from the method's name, never by calling
// it, and a nil handle makes it impossible for workflow code to invoke one
// directly by accident.
var acts *activities.Activities

// The control surface. One signal and one query for the dispatcher, plus the
// signal children report completion on.
const (
	// SignalUpdateConfig carries a work.ConfigUpdate. Nil fields mean leave
	// alone, so one message serves a deploy pushing settings and a human
	// pausing the system.
	SignalUpdateConfig = "update-config"

	// QueryStatus returns a work.DispatcherStatus: what is in flight, and why
	// nothing more is.
	QueryStatus = "status"

	// SignalTicketDone carries a work.TicketDone from a finishing run.
	//
	// It is not part of the control surface ADR-0011 keeps to one signal and
	// one query — that surface is what a human or a deploy drives. This is
	// machinery between two workflows, and collapsing it into UpdateConfig
	// would make a human's message and a child's report the same message.
	SignalTicketDone = "ticket-done"
)

// WorkTicketInput is one ticket's run.
type WorkTicketInput struct {
	Ticket work.Ticket

	// Config and Policy are both resolved by the dispatcher at the moment the
	// run starts, and then fixed. A run finishes under the configuration it
	// began with, so an update mid-flight cannot retune a pipeline halfway
	// through — and the models a plan was made under are the models its review
	// and implementation run under.
	Config work.Config
	Policy work.RunPolicy

	// DispatcherID is the workflow to report completion to. Empty means nobody
	// is listening, which is the case for a run started by hand.
	DispatcherID string
}

// WorkTicketResult is what the run did.
type WorkTicketResult struct {
	Outcome work.Outcome

	// PullRequest is the URL propose opened, and is set only when Outcome is
	// proposed.
	PullRequest string

	// Usage is every stage's tokens, totalled. It is the run's whole cost, and
	// it is in the result so the number survives in workflow history rather
	// than only in a metric.
	Usage work.Usage

	// Detail is why a run blocked, or what it was doing when it failed.
	Detail string
}

// WorkTicket plans, reviews, revises, implements and proposes one ticket, then
// stops. Merging the pull request it opens stays a human act.
//
// It always cleans up: the sandbox is deleted and the dispatcher is told the
// slot is free whether the run succeeded, failed or was cancelled. Both happen
// on a disconnected context, because a cancelled workflow's ordinary context is
// already dead and cleanup that runs only on the happy path is not cleanup.
func WorkTicket(ctx workflow.Context, in WorkTicketInput) (WorkTicketResult, error) {
	if err := validate(in); err != nil {
		return WorkTicketResult{}, err
	}

	run := &ticketRun{
		in:       in,
		runID:    workflow.GetInfo(ctx).WorkflowExecution.RunID,
		comments: map[work.StatusStep]work.CommentID{},
	}
	result, err := run.execute(ctx)
	run.finish(ctx, result, err)
	return result, err
}

// validate refuses an input no run could be made from.
//
// Non-retryable, and before anything is created: a run started on a policy with
// no stage timeout would otherwise create a pod, then fail on the first stage,
// then be retried into the same wall.
func validate(in WorkTicketInput) error {
	if in.Ticket.Number <= 0 {
		return temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("ticket number %d is not an issue number", in.Ticket.Number),
			activities.ErrTypeInvalid, nil)
	}
	if err := in.Policy.Validate(); err != nil {
		return temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("the run policy for ticket #%d is unusable: %v", in.Ticket.Number, err),
			activities.ErrTypeInvalid, nil)
	}
	if err := in.Config.Validate(); err != nil {
		return temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("the config for ticket #%d is unusable: %v", in.Ticket.Number, err),
			activities.ErrTypeInvalid, nil)
	}
	return nil
}

// ticketRun is one run's mutable state: what it has created, spent and said.
//
// It exists so cleanup can see what setup got as far as doing. A run that fails
// between creating a sandbox and using it must still delete that sandbox, which
// means the identifier has to outlive the function that obtained it.
type ticketRun struct {
	in    WorkTicketInput
	runID string

	sandbox work.SandboxID
	usage   work.Usage

	// comments is one comment per status step. A stage's comment is posted when
	// the stage starts and edited when it ends, so the ID has to survive
	// between those two moments and must not be shared with another step.
	comments map[work.StatusStep]work.CommentID
}

// execute is the pipeline. Everything it creates, it records on the run first,
// so finish can undo it.
func (r *ticketRun) execute(ctx workflow.Context) (WorkTicketResult, error) {
	control := workflow.WithActivityOptions(ctx, r.controlOptions())

	r.report(ctx, work.StatusReport{Step: work.StepPickup, State: work.StepRunning})

	var detail work.TicketDetail
	if err := workflow.ExecuteActivity(control, acts.FetchTicketDetail, r.in.Ticket.Number).Get(ctx, &detail); err != nil {
		return WorkTicketResult{Outcome: work.OutcomeFailed}, err
	}

	create := activities.CreateSandboxInput{
		TicketNumber: r.in.Ticket.Number,
		RunID:        r.runID,
		RunTimeout:   r.in.Policy.RunTimeout,
	}
	if err := workflow.ExecuteActivity(control, acts.CreateSandbox, create).Get(ctx, &r.sandbox); err != nil {
		return WorkTicketResult{Outcome: work.OutcomeFailed}, err
	}
	if err := workflow.ExecuteActivity(control, acts.WaitSandboxReady, r.sandbox).Get(ctx, nil); err != nil {
		return WorkTicketResult{Outcome: work.OutcomeFailed}, err
	}

	// codex refuses to run outside a git repository, so the checkout must
	// exist before the first stage or a run that discovered that inside `plan`
	// would already have paid for a stage against a sandbox that could never
	// have worked. The codex credential itself no longer needs a matching
	// activity here at all (D3, #434): CreateSandbox already wrote it into a
	// per-ticket Secret, the pod's own spec mounted that Secret, and
	// cmd/sandbox-worker symlinked work.CodexAuthFile to it before
	// registering RunStage — all of that done before WaitSandboxReady's wait
	// ever returned.
	clone := workflow.WithActivityOptions(ctx, r.cloneOptions())
	if err := workflow.ExecuteActivity(clone, acts.CloneRepo, r.sandbox).Get(ctx, nil); err != nil {
		return WorkTicketResult{Outcome: work.OutcomeFailed}, err
	}

	// Every completed stage's output, not just the last. revise reads the
	// plan and the review, and the plan is two stages behind it by then — a
	// single rolling handoff would have discarded it, and the run would die at
	// stage three having paid for two.
	//
	// One slot per stage, last-write-wins: today's pipeline runs each stage
	// exactly once, so this is the whole history. See buildStageInput's own
	// note in internal/prompts/input.go for why this does not extend to a
	// stage invoked more than once.
	prior := make(map[work.Stage]work.StageOutput, len(work.Pipeline()))

	// One Session for the whole stage loop (#434 step 3, D2/B3): exactly one
	// CreateSession per run, matched by exactly one CompleteSession at the
	// run's true end — success, failure or cancellation, never per-stage. The
	// defer is what makes "every exit path" cheap rather than a branch at
	// each return below: CompleteSession is a provable no-op when called
	// twice or on a session that already failed (temporal-session-semantics
	// spec, #2), so nothing here needs to track whether the loop already
	// left through an error return.
	//
	// CloneRepo, above, runs OUTSIDE this session — see activities.SandboxDeps'
	// doc comment for why: it still depends on the pods/exec transport
	// internal/clients/k8s keeps alive, not on the sandbox pod's own embedded
	// worker, so pinning it to a session that worker hosts would just fail to
	// schedule it at all.
	sessionCtx, err := r.createSession(ctx)
	if err != nil {
		return WorkTicketResult{Outcome: work.OutcomeFailed}, err
	}
	defer workflow.CompleteSession(sessionCtx)

	stages := workflow.WithActivityOptions(sessionCtx, r.stageOptions())

	for _, stage := range work.Pipeline() {
		model := r.in.Config.ModelFor(stage)
		startedAt := workflow.Now(ctx)
		r.report(ctx, work.StatusReport{
			Step: work.StageStep(stage), State: work.StepRunning,
			Stage: stage, Model: model, StartedAt: startedAt,
		})

		in := activities.RunStageInput{
			Key:     work.StageKey{Ticket: r.in.Ticket.Number, RunID: r.runID, Stage: stage},
			Sandbox: r.sandbox,
			Model:   model,
			Detail:  detail,
			Prior:   prior,
		}

		var out activities.RunStageOutput
		if err := workflow.ExecuteActivity(stages, acts.RunStage, in).Get(ctx, &out); err != nil {
			// Reported before the error is returned. A stage that failed is the
			// one a human most wants to see on the ticket, and the tokens it
			// spent are still spent.
			r.report(ctx, work.StatusReport{
				Step: work.StageStep(stage), State: work.StepFailed,
				Stage: stage, Model: model, StartedAt: startedAt, EndedAt: workflow.Now(ctx),
				Usage: out.Usage, Detail: stageFailureDetail(err),
			})
			return WorkTicketResult{Outcome: work.OutcomeFailed, Usage: r.usage}, err
		}

		// Tokens are counted as soon as the stage returns: they were spent
		// whatever it produced.
		r.usage = r.usage.Add(out.Usage)
		prior[stage] = out.Result
		r.persistTranscript(ctx, in.Key, out.Transcript)

		r.report(ctx, work.StatusReport{
			Step: work.StageStep(stage), State: work.StepSucceeded,
			Stage: stage, Model: model, StartedAt: startedAt, EndedAt: workflow.Now(ctx),
			Usage: out.Usage,
		})
	}

	// What the run achieved is asked of GitHub, never read out of what the
	// propose stage said it did. Every stage's output is model text derived
	// from a ticket an attacker may have written, so letting it decide the
	// outcome would let it decide the outcome. A branch the worker named and a
	// pull request GitHub reports on it cannot be forged from an issue body.
	branch := work.BranchName(r.in.Ticket.Number, r.runID)
	var found activities.FindPullRequestOutput
	if err := workflow.ExecuteActivity(control, acts.FindPullRequest, branch).Get(ctx, &found); err != nil {
		return WorkTicketResult{Outcome: work.OutcomeFailed, Usage: r.usage}, err
	}

	if !found.Found {
		// Not a failure. Every stage ran and propose declined to open a pull
		// request — which is the machine saying it could not do this ticket,
		// and is exactly the "blocked" ADR-0011 names as one of the two moments
		// the auto label comes off.
		return WorkTicketResult{
			Outcome: work.OutcomeBlocked,
			Usage:   r.usage,
			Detail:  fmt.Sprintf("no pull request was opened on %s", branch),
		}, nil
	}

	return WorkTicketResult{
		Outcome:     work.OutcomeProposed,
		PullRequest: found.PullRequest.URL,
		Usage:       r.usage,
	}, nil
}

// finish releases everything the run holds, whatever happened to it.
//
// It runs on a disconnected context. A cancelled workflow's own context is
// already cancelled, so cleanup written against it would be skipped exactly
// when it matters most — cancellation is the case where a pod is most likely to
// be left behind.
//
// Nothing here can fail the run: it is called after the outcome is decided, and
// a failure to tidy up must not overwrite the reason a run ended. Each step logs
// instead, and the one that matters — the pod — is caught by the dispatcher's
// orphan sweep if it fails here too.
func (r *ticketRun) finish(ctx workflow.Context, result WorkTicketResult, runErr error) {
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

	// A cancelled run decided nothing, so the ticket still wants machine work
	// and keeps its label. Every other ending clears it — including a failure.
	// ADR-0011 names "a PR opened, or blocked" as the moments the label comes
	// off; leaving it on after a hard failure would mean the dispatcher lists
	// the ticket again on the next poll and fails it again, forever, which is
	// the unbounded requeue this system is built to avoid.
	if !cancelled {
		if err := workflow.ExecuteActivity(control, acts.ClearAutoLabel, r.in.Ticket.Number).Get(ctx, nil); err != nil {
			log.Error("clearing the auto label failed; this ticket will be listed again",
				"ticket", r.in.Ticket.Number, "error", err)
			// An auth failure here is the case that matters: the label stays on,
			// so the dispatcher must hear about it and pause. It only replaces
			// the run's own kind when that kind was not already specific — a
			// rate-limited run whose label clear also failed is still
			// rate-limited.
			if failure == work.FailureNone || failure == work.FailureOther {
				failure = activities.FailureKindOf(err)
			}
		}
	}

	outcome := result.Outcome
	if outcome == "" {
		outcome = work.OutcomeFailed
	}

	detail := result.Detail
	if runErr != nil && detail == "" {
		detail = runErr.Error()
	}

	state := work.StepSucceeded
	if outcome != work.OutcomeProposed {
		state = work.StepFailed
	}
	r.report(ctx, work.StatusReport{
		Step: work.StepOutcome, State: state,
		Outcome: outcome, Detail: detail, EndedAt: workflow.Now(ctx),
		// result.PullRequest is what FindPullRequest got back from GitHub for
		// this run's own branch — see execute — never a value a stage wrote
		// into its own result file. Only meaningful when the run proposed;
		// result.PullRequest is empty otherwise, so this is a no-op for every
		// other outcome.
		PullRequestURL: result.PullRequest,
	})
	r.tellDispatcher(ctx, work.TicketDone{
		Ticket:  r.in.Ticket.Number,
		RunID:   r.runID,
		Outcome: outcome,
		Failure: failure,
		Detail:  detail,
	})
}

// tellDispatcher reports the slot free.
//
// A failure to deliver is logged and not raised: the dispatcher's periodic
// reconcile is the backstop, and failing a finished run because its
// notification bounced would turn a successful ticket into a failed one.
func (r *ticketRun) tellDispatcher(ctx workflow.Context, done work.TicketDone) {
	if r.in.DispatcherID == "" {
		return
	}

	// An empty run ID targets whichever run of the dispatcher is current. It
	// has to: the dispatcher ContinueAsNews, so the run that started this
	// ticket is usually not the run that needs to hear it finished.
	err := workflow.SignalExternalWorkflow(ctx, r.in.DispatcherID, "", SignalTicketDone, done).Get(ctx, nil)
	if err != nil {
		workflow.GetLogger(ctx).Error("could not tell the dispatcher this ticket finished; "+
			"its reconcile will free the slot instead", "dispatcher", r.in.DispatcherID, "error", err)
	}
}

// report updates the run's one status comment, filling in the fields every
// report shares so no call site can forget the comment ID and post a second
// comment.
//
// Best-effort by design: a run must not fail because GitHub would not take a
// progress update.
func (r *ticketRun) report(ctx workflow.Context, report work.StatusReport) {
	report.TicketNumber = r.in.Ticket.Number
	report.RunID = r.runID
	report.Comment = r.comments[report.Step]

	// The outcome comment carries the run's total; a stage's carries its own,
	// which the caller has already set.
	if report.Step == work.StepOutcome {
		report.Usage = r.usage
	}

	control := workflow.WithActivityOptions(ctx, r.controlOptions())

	var id work.CommentID
	if err := workflow.ExecuteActivity(control, acts.ReportStatus, report).Get(ctx, &id); err != nil {
		workflow.GetLogger(ctx).Error("could not update the status comment",
			"ticket", r.in.Ticket.Number, "step", string(report.Step), "error", err)
		return
	}
	r.comments[report.Step] = id
}

// persistTranscript relays one stage's transcript out of the sandbox pod and
// into the durable, NFS-backed sink the rest of this service trusts (#434
// step 3, D5).
//
// It always runs on the MAIN worker's queue, never the sandbox's per-ticket
// one — control is rebuilt from ctx here rather than reusing whatever
// ActivityOptions the caller already has in scope, the same "derive it
// fresh" shape report() already uses, and for the same reason: this call must
// land on work.TaskQueue regardless of which ActivityOptions happen to be on
// the context the caller is holding (the stage loop's own is the session's
// per-ticket queue). PersistTranscript's own doc comment names this same
// requirement from the activity side.
//
// Best-effort, the same shape as report(): the transcript is forensics, not
// the run's actual work, and the tokens a stage spent are already spent
// whether or not its transcript makes it home. A run must not fail because
// the relay could not.
func (r *ticketRun) persistTranscript(ctx workflow.Context, key work.StageKey, transcript work.Transcript) {
	control := workflow.WithActivityOptions(ctx, r.controlOptions())

	in := activities.PersistTranscriptInput{Key: key, Transcript: transcript}
	if err := workflow.ExecuteActivity(control, acts.PersistTranscript, in).Get(ctx, nil); err != nil {
		workflow.GetLogger(ctx).Error("could not persist the stage transcript; it stays on the sandbox pod's own disk and is lost once DeleteSandbox removes it",
			"ticket", r.in.Ticket.Number, "run_id", r.runID, "stage", string(key.Stage), "error", err)
	}
}

// stageFailureDetail renders a stage's error for its status comment.
//
// workflow.ErrSessionFailed means the session's host pod died (Kata VM
// crash, OOM, node pressure) — reported synchronously rather than waited out
// over the stage's own timeout (durations.go's SessionExecutionTimeout doc
// comment; temporal-session-semantics spec, #5) — and is called out by name
// here rather than left as a bare Temporal error string, because there is
// nothing to resume: /work was that pod's own emptyDir, gone with it. Pulled
// out of the stage loop as its own function so this rendering is testable
// without simulating the SDK's own session-failure detection.
func stageFailureDetail(err error) string {
	if errors.Is(err, workflow.ErrSessionFailed) {
		return fmt.Sprintf("the sandbox's session failed — its pod is gone and cannot be resumed: %v", err)
	}
	return err.Error()
}

// createSession claims this run's sandbox pod as a Temporal Session host, so
// every stage's RunStage lands on the same pod and the same embedded worker
// (#434 step 3, D1/D2).
//
// ActivityOptions.TaskQueue is set to this run's own SandboxTaskQueue before
// CreateSession is called: the session is created on the queue named there
// (verified against sdk-go v1.47.0 — CreateSession's own doc comment, "The
// session will be created on the taskqueue user specified in
// ActivityOptions"), which is what makes it this run's own sandbox pod that
// claims it and not any other. With no warm pool (D1) there is exactly one
// poller on that queue, so nothing else could claim it regardless.
//
// SessionExecutionTimeout/SessionCreationTimeout come from the durations
// ladder (work/durations.go), not literals here, for the reason every other
// number on that ladder is centralised: an operator who retunes one without
// re-deriving the rest should see it fail in durations_test.go, not in a
// production run.
func (r *ticketRun) createSession(ctx workflow.Context) (workflow.Context, error) {
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

	// HostName is populated the instant CreateSession returns nil — verified
	// against sdk-go source, not merely documented (temporal-session-semantics
	// spec, #3) — so this is never a stale or partial read. It is the pod
	// identity observable the step-3 acceptance run checks Temporal history
	// for (acceptance criterion 3).
	info := workflow.GetSessionInfo(sessionCtx)
	workflow.GetLogger(ctx).Info("sandbox session created",
		"sandbox", r.sandbox, "session_id", info.SessionID, "session_host", info.HostName)

	return sessionCtx, nil
}

// controlOptions govern the cheap activities: short, and retried freely,
// because failing one of them would discard every token the run has spent.
func (r *ticketRun) controlOptions() workflow.ActivityOptions {
	return workflow.ActivityOptions{
		StartToCloseTimeout: r.in.Policy.ControlTimeout,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: r.in.Policy.ControlAttempts},
	}
}

// cloneOptions govern the clone: no model tokens are at stake and it is
// idempotent by construction (see k8s.Sandboxes.CloneRepo), so it is retried
// as freely as the control activities — but on a stage's own timeout rather
// than the control one, because a git clone of this repository is not bounded
// by "a status comment can always be posted in two minutes".
func (r *ticketRun) cloneOptions() workflow.ActivityOptions {
	return workflow.ActivityOptions{
		StartToCloseTimeout: r.in.Policy.StageTimeout,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: r.in.Policy.ControlAttempts},
	}
}

// stageOptions govern a stage: generous, heartbeated, and retried barely at
// all.
//
// The heartbeat timeout is what makes an hour-long activity cancellable rather
// than a black box — without it a stage whose process died is indistinguishable
// from one that is thinking, until the whole hour is gone.
func (r *ticketRun) stageOptions() workflow.ActivityOptions {
	return workflow.ActivityOptions{
		StartToCloseTimeout: r.in.Policy.StageTimeout,
		HeartbeatTimeout:    r.in.Policy.StageHeartbeatTimeout,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: r.in.Policy.StageAttempts},
	}
}
