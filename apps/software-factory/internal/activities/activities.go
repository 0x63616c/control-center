package activities

import (
	"context"
	"fmt"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/telemetry"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/sdk/activity"
)

// Deps are everything the activities need, named rather than positional.
//
// SoftwareStyle asks for required dependencies positional. Ten of them in a
// row is the case that rule is not written for: at that width the call site
// stops saying which argument is which, and a legibility rule that produced an
// illegible call site would be enforcing its letter against its purpose. Named
// fields keep the composition root readable and New still validates once, so
// nothing about the "no usable-but-invalid zero value" guarantee is weakened.
type Deps struct {
	GitHub      GitHub
	Pods        PodLifecycle
	Stages      StageRunner
	Transcripts TranscriptSink
	Prompts     PromptRenderer
	Status      StatusRenderer
	Runs        RunLookup
	Sweeper     SandboxSweeper
	Metrics     Metrics

	// Clock is how an activity times itself. Wall-clock time is an external
	// edge like any other, and internal/clock is the one place it is read.
	Clock clock.Clock

	// Sandbox is the shape every ticket's pod is built to. It is deploy-time
	// config, not a runtime knob — see work.SandboxTemplate.
	Sandbox work.SandboxTemplate
}

// Activities is every side effect this service has, as the workflows see it.
//
// Each method is thin on purpose: call one seam, translate its error into
// Temporal's taxonomy exactly once, and return a domain value. The interesting
// code is behind the seams, and the interesting *decisions* are in the
// workflows; anything that grew logic here would be logic Temporal cannot
// replay and a workflow test cannot see.
type Activities struct {
	deps Deps
}

// New builds the activity set, or reports which dependency is missing.
func New(deps Deps) (*Activities, error) {
	missing := []string{}
	if deps.GitHub == nil {
		missing = append(missing, "GitHub")
	}
	if deps.Pods == nil {
		missing = append(missing, "Pods")
	}
	if deps.Stages == nil {
		missing = append(missing, "Stages")
	}
	if deps.Transcripts == nil {
		missing = append(missing, "Transcripts")
	}
	if deps.Prompts == nil {
		missing = append(missing, "Prompts")
	}
	if deps.Status == nil {
		missing = append(missing, "Status")
	}
	if deps.Runs == nil {
		missing = append(missing, "Runs")
	}
	if deps.Sweeper == nil {
		missing = append(missing, "Sweeper")
	}
	if deps.Metrics == nil {
		missing = append(missing, "Metrics")
	}
	if deps.Clock == nil {
		missing = append(missing, "Clock")
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("activities need %v", missing)
	}
	if err := deps.Sandbox.Validate(); err != nil {
		return nil, fmt.Errorf("activities need a usable sandbox template: %w", err)
	}
	return &Activities{deps: deps}, nil
}

// ListAutoTickets returns the open issues asking for machine work.
func (a *Activities) ListAutoTickets(ctx context.Context) ([]work.Ticket, error) {
	tickets, err := a.deps.GitHub.ListAutoTickets(ctx)
	if err != nil {
		return nil, fail(ctx, "listing tickets labelled auto", err)
	}
	activity.GetLogger(ctx).Debug("listed auto tickets", "count", len(tickets))
	return tickets, nil
}

// FetchTicketDetail reads a ticket and the discussion on it.
//
// A run reads this once and carries it through every stage, so all five stages
// plan against the same ask. Re-reading per stage would let a comment posted
// mid-run change the requirements under a plan that had already been reviewed.
func (a *Activities) FetchTicketDetail(ctx context.Context, number int) (work.TicketDetail, error) {
	detail, err := a.deps.GitHub.TicketDetail(ctx, number)
	if err != nil {
		return work.TicketDetail{}, fail(ctx, fmt.Sprintf("reading ticket #%d", number), err)
	}
	return detail, nil
}

// ReportStatus posts the run's status comment, or edits the one it already
// posted, and returns the comment it wrote.
//
// One activity rather than a post/edit pair, because "post once then edit"
// is a rule about the run, and a caller that could choose would eventually
// choose wrong. The choice is made from the report's own Comment field, which
// is zero exactly until a comment exists.
func (a *Activities) ReportStatus(ctx context.Context, report work.StatusReport) (work.CommentID, error) {
	body := a.deps.Status.Render(report)

	if report.Comment == 0 {
		id, err := a.deps.GitHub.PostStatus(ctx, report.TicketNumber, body)
		if err != nil {
			return 0, fail(ctx, fmt.Sprintf("posting the status comment on issue #%d", report.TicketNumber), err)
		}
		return id, nil
	}

	if err := a.deps.GitHub.EditStatus(ctx, report.Comment, body); err != nil {
		return report.Comment, fail(ctx, fmt.Sprintf("editing the status comment on issue #%d", report.TicketNumber), err)
	}
	return report.Comment, nil
}

// ClearAutoLabel removes `auto`, which the machine does when it has opened a
// pull request or given up. A human re-adds it to ask for another pass.
func (a *Activities) ClearAutoLabel(ctx context.Context, issue int) error {
	if err := a.deps.GitHub.ClearAutoLabel(ctx, issue); err != nil {
		return fail(ctx, fmt.Sprintf("clearing the auto label on issue #%d", issue), err)
	}
	return nil
}

// CreateSandboxInput asks for one run's pod.
type CreateSandboxInput struct {
	TicketNumber int

	// RunID scopes the pod to this run, so an AlreadyExists on create can only
	// mean "my own create is being retried" and never "an older run left this
	// behind". See work.SandboxSpec.
	RunID string

	// RunTimeout is the longest the enclosing run can legitimately take. It is
	// passed rather than derived because the pod's deadline is deploy config
	// and the timeout is run policy, and this is the one place both are known.
	RunTimeout time.Duration
}

// CreateSandbox creates the pod this run's stages execute in.
func (a *Activities) CreateSandbox(ctx context.Context, in CreateSandboxInput) (work.SandboxID, error) {
	deadline := time.Duration(a.deps.Sandbox.DeadlineSeconds) * time.Second
	if deadline <= in.RunTimeout {
		// Kubernetes killing a pod the workflow still believes in produces a
		// stage that fails for no stated reason, on a timer nobody was watching.
		// Refuse at the first ticket instead, permanently: no retry changes a
		// deploy-time number.
		return "", fail(ctx, "checking the sandbox deadline", fmt.Errorf(
			"the pod deadline %s must exceed the run timeout %s, or Kubernetes kills a pod Temporal still believes in: %w",
			deadline, in.RunTimeout, work.ErrPermanent))
	}

	id, err := a.deps.Pods.Create(ctx, a.deps.Sandbox.Spec(in.TicketNumber, in.RunID))
	if err != nil {
		return "", fail(ctx, fmt.Sprintf("creating the sandbox for ticket #%d", in.TicketNumber), err)
	}
	return id, nil
}

// WaitSandboxReady blocks until the sandbox can be executed into.
func (a *Activities) WaitSandboxReady(ctx context.Context, sandbox work.SandboxID) error {
	if err := a.deps.Pods.WaitReady(ctx, sandbox); err != nil {
		return fail(ctx, fmt.Sprintf("waiting for sandbox %s", sandbox), err)
	}
	return nil
}

// DeleteSandbox destroys the pod. It is called from a disconnected context by
// its workflow, so a cancelled run still cleans up after itself.
func (a *Activities) DeleteSandbox(ctx context.Context, sandbox work.SandboxID) error {
	if err := a.deps.Pods.Delete(ctx, sandbox); err != nil {
		return fail(ctx, fmt.Sprintf("deleting sandbox %s", sandbox), err)
	}
	return nil
}

// RunStageInput is one stage attempt.
type RunStageInput struct {
	Key     work.StageKey
	Sandbox work.SandboxID
	Model   work.Model

	// Detail is the ticket as the run read it at pickup, identical for every
	// stage of the run.
	Detail work.TicketDetail

	// Prior holds every completed stage's document, keyed by the stage that
	// produced it, and is empty for the first stage. Every one of them, not
	// only the last: revise reads the plan as well as the review, and the plan
	// is two stages back by then.
	Prior map[work.Stage]string
}

// RunStageOutput is what a stage produced.
//
// It deliberately does not carry a work.Credential or any part of one. Activity
// results are written to workflow history and kept for the namespace's whole
// retention.
type RunStageOutput struct {
	// Output is the raw result envelope, kept because it is what the transcript
	// and any later forensics want.
	Output []byte

	// Document is the document inside that envelope, which is what the next
	// stage's prompt is rendered from.
	Document string

	ThreadID string
	Usage    work.Usage
}

// RunStage renders a stage's prompt, runs it in the sandbox, and stores its
// event stream.
//
// The event sink does two jobs at once because there is exactly one stream and
// two consumers of it: the transcript wants the bytes, and Temporal wants to
// know the stage is alive. A stage that emits nothing for the heartbeat timeout
// is dead rather than slow, and only the stream can tell the difference.
func (a *Activities) RunStage(ctx context.Context, in RunStageInput) (RunStageOutput, error) {
	log := activity.GetLogger(ctx)

	prompt, schema, err := a.deps.Prompts.Render(in.Key.Stage, in.Detail, in.Prior)
	if err != nil {
		return RunStageOutput{}, fail(ctx, fmt.Sprintf("rendering the prompt for %s", in.Key), err)
	}

	transcript, err := a.deps.Transcripts.Open(ctx, in.Key)
	if err != nil {
		return RunStageOutput{}, fail(ctx, fmt.Sprintf("opening the transcript for %s", in.Key), err)
	}
	defer func() {
		if closeErr := transcript.Close(); closeErr != nil {
			// Never fails the stage. The tokens are already spent, and the
			// record of the work is worth less than the work.
			log.Error("closing the transcript failed", "stage", in.Key.String(), "error", closeErr)
		}
	}()

	events := func(rawEvent []byte) {
		activity.RecordHeartbeat(ctx)
		if _, writeErr := transcript.Write(append(rawEvent, '\n')); writeErr != nil {
			log.Error("writing to the transcript failed", "stage", in.Key.String(), "error", writeErr)
		}
	}

	started := a.deps.Clock.Now()
	result, err := a.deps.Stages.RunStage(ctx, work.StageRun{
		Key:     in.Key,
		Sandbox: in.Sandbox,
		Model:   in.Model,
		Prompt:  prompt,
		Schema:  schema,
	}, events)
	took := a.deps.Clock.Now().Sub(started)
	if err != nil {
		// Recorded before the error is returned, not after: a stage that failed
		// spent its tokens too, and a metric that only counts successes makes
		// the expensive case the invisible one.
		a.deps.Metrics.StageFinished(in.Key.Stage, in.Model, outcomeOf(err), result.Usage, took)
		return RunStageOutput{}, fail(ctx, fmt.Sprintf("running %s", in.Key), err)
	}
	a.deps.Metrics.StageFinished(in.Key.Stage, in.Model, telemetry.OutcomeSuccess, result.Usage, took)

	log.Info("stage finished",
		"stage", string(in.Key.Stage),
		"ticket", in.Key.Ticket,
		"model", in.Model.Name,
		"input_tokens", result.Usage.InputTokens,
		"output_tokens", result.Usage.OutputTokens)

	document, err := a.deps.Prompts.Document(result.Output)
	if err != nil {
		return RunStageOutput{}, fail(ctx, fmt.Sprintf("reading the result envelope of %s", in.Key), err)
	}

	return RunStageOutput{
		Output:   result.Output,
		Document: document,
		ThreadID: result.ThreadID,
		Usage:    result.Usage,
	}, nil
}

// FindPullRequestOutput is what GitHub says is open on a run's branch.
//
// Found is a field rather than an empty URL meaning "none", because the two
// answers lead to opposite outcomes — a proposal and a block — and a caller
// that had to infer one from an empty string would eventually infer wrong.
type FindPullRequestOutput struct {
	Found       bool
	PullRequest work.PullRequest
}

// FindPullRequest asks GitHub what a run actually achieved.
//
// It is the run's outcome, and it comes from GitHub rather than from what the
// propose stage said it did. A stage's report is model output; GitHub's answer
// about a branch the worker named is not.
func (a *Activities) FindPullRequest(ctx context.Context, branch string) (FindPullRequestOutput, error) {
	pr, found, err := a.deps.GitHub.PullRequestForBranch(ctx, branch)
	if err != nil {
		return FindPullRequestOutput{}, fail(ctx, fmt.Sprintf("looking for a pull request on %s", branch), err)
	}
	return FindPullRequestOutput{Found: found, PullRequest: pr}, nil
}

// DescribeRun reports whether a ticket's workflow is still open, and which run
// owns it.
//
// This is the dispatcher's reconcile: a run that died without signalling would
// otherwise hold its slot forever.
func (a *Activities) DescribeRun(ctx context.Context, workflowID string) (work.RunState, error) {
	state, err := a.deps.Runs.Describe(ctx, workflowID)
	if err != nil {
		return work.RunState{}, fail(ctx, fmt.Sprintf("describing workflow %s", workflowID), err)
	}
	return state, nil
}

// SweepInput names the runs whose sandboxes must survive.
type SweepInput struct {
	// LiveRunIDs is what the dispatcher believes is working. Anything else is a
	// candidate.
	LiveRunIDs []string

	// MinAge is the floor below which a pod is never swept, whatever LiveRunIDs
	// says. A pod is created before its run is recorded, so without a floor the
	// sweep would race the run that owns it.
	MinAge time.Duration
}

// SweepResult is how many pods the sweep deleted.
type SweepResult struct {
	Deleted int
}

// SweepOrphanSandboxes deletes sandbox pods no live run owns.
//
// The dispatcher owns this because it is the only long-lived thing in the
// system: a worker that dies mid-ticket takes with it the workflow that would
// have deleted the pod, so nothing else is positioned to reconcile it (#334).
func (a *Activities) SweepOrphanSandboxes(ctx context.Context, in SweepInput) (SweepResult, error) {
	if in.MinAge <= 0 {
		return SweepResult{}, fail(ctx, "sweeping orphaned sandboxes", fmt.Errorf(
			"a sweep with no minimum age would delete pods out from under their own runs: %w", work.ErrPermanent))
	}

	deleted, err := a.deps.Sweeper.SweepOrphans(ctx, in.LiveRunIDs, in.MinAge)
	if err != nil {
		return SweepResult{}, fail(ctx, "sweeping orphaned sandboxes", err)
	}
	if deleted > 0 {
		activity.GetLogger(ctx).Warn("deleted orphaned sandboxes",
			"deleted", deleted, "live_runs", len(in.LiveRunIDs))
	}
	return SweepResult{Deleted: deleted}, nil
}
