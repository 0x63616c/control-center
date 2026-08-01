package activities

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
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
	GitHub  GitHub
	Pods    PodLifecycle
	Repo    RepoCloner
	Runs    RunLookup
	Sweeper SandboxSweeper

	// DispatcherState records the dispatcher's per-tick projection (#551), the
	// store row the console will eventually read instead of querying Temporal.
	DispatcherState DispatcherStateWriter

	// RepoURL is the ticket repository's clone URL. It is deploy-time config,
	// like Sandbox: built once from the App's own owner/repo at the composition
	// root, never attacker-influenced, and handed to CloneRepo rather than
	// assembled inside it so that this package has exactly one seam that reads
	// deploy config as opposed to a live dependency.
	RepoURL string

	// Log is the injected logger. Clients and activities log themselves, so
	// leaf code rarely logs by hand and nobody can forget.
	Log *slog.Logger

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
	if deps.Repo == nil {
		missing = append(missing, "Repo")
	}
	if deps.Runs == nil {
		missing = append(missing, "Runs")
	}
	if deps.Sweeper == nil {
		missing = append(missing, "Sweeper")
	}
	if deps.DispatcherState == nil {
		missing = append(missing, "DispatcherState")
	}
	if deps.Log == nil {
		missing = append(missing, "Log")
	}
	if deps.Clock == nil {
		missing = append(missing, "Clock")
	}
	if deps.RepoURL == "" {
		missing = append(missing, "RepoURL")
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("activities need %v", missing)
	}
	if err := deps.Sandbox.Validate(); err != nil {
		return nil, fmt.Errorf("activities need a usable sandbox template: %w", err)
	}
	return &Activities{deps: deps}, nil
}

// RecordDispatcherState writes one post-tick dispatcher projection (#551) —
// I/O, and therefore an activity rather than something the workflow does
// itself (SoftwareStyle tenet 10).
func (a *Activities) RecordDispatcherState(ctx context.Context, state store.DispatcherState) error {
	if err := a.deps.DispatcherState.PutDispatcherState(ctx, state); err != nil {
		return fail(ctx, "recording dispatcher state", err)
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
//
// Provider credentials stay on the main worker and are never provisioned into
// this sandbox.
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

	spec := a.deps.Sandbox.SpecForFactoryTicket(int64(in.TicketNumber), in.RunID)
	id, err := a.deps.Pods.Create(ctx, spec)
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

// CloneRepo checks the ticket's repository out inside the sandbox and pushes
// this run's branch. It must run once the sandbox is ready and before the
// first tool call: repository tools are intentionally unavailable until the
// checkout exists.
//
// The credential is minted here, inside the activity that uses it, and never
// returned: like InstallationToken's own doc says, Temporal persists an
// activity's result to workflow history for the namespace's whole retention,
// and a token that crossed that boundary would sit there for as long as the
// history does.
func (a *Activities) CloneRepo(ctx context.Context, sandbox work.SandboxID) error {
	credential, err := a.deps.GitHub.InstallationToken(ctx)
	if err != nil {
		return fail(ctx, fmt.Sprintf("minting a credential to clone into sandbox %s", sandbox), err)
	}
	if err := a.deps.Repo.CloneRepo(ctx, sandbox, a.deps.RepoURL, credential); err != nil {
		return fail(ctx, fmt.Sprintf("cloning the repository into sandbox %s", sandbox), err)
	}
	return nil
}

// PushRepo publishes a successful implement turn from the credential-only
// repository sidecar. The fresh installation token never crosses history.
func (a *Activities) PushRepo(ctx context.Context, sandbox work.SandboxID) error {
	credential, err := a.deps.GitHub.InstallationToken(ctx)
	if err != nil {
		return fail(ctx, fmt.Sprintf("minting a credential to push from sandbox %s", sandbox), err)
	}
	if err := a.deps.Repo.PushRepo(ctx, sandbox, a.deps.RepoURL, credential); err != nil {
		return fail(ctx, fmt.Sprintf("pushing the repository from sandbox %s", sandbox), err)
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

// stageInput is one stage attempt's input, common to every stage. RunPlanInput,
// RunImplementInput and RunReviewInput each embed it rather than repeating its
// fields, so the plumbing that renders a prompt and runs it is written once
// against this shape and each stage's own activity method (below) is a thin,
// named wrapper. These types remain only as a Temporal history compatibility
// contract for the pre-AgentWorkflow per-stage activities.
type stageInput struct {
	Key     work.StageKey
	Sandbox work.SandboxID
	Model   work.Model

	// Detail is the ticket as the run read it at pickup, identical for every
	// stage and every turn of the run.
	Detail work.TicketDetail

	// Prior is exactly the plan, the latest implement turn and the latest
	// review turn — see work.PriorTurns' own doc comment for why this
	// activity input is never wider than that. The workflow
	// (internal/workflows) keeps the run's full turn history in its own
	// local state, for progress detection, and narrows to this shape itself
	// before building a turn's StageAttempt — not here, and not in
	// internal/prompts, so there is exactly one place a caller could widen
	// it back out, and that place is the one that has to justify it.
	Prior work.PriorTurns
}

// stageOutput is one stage attempt's result, common to every stage.
// RunPlanOutput, RunImplementOutput and RunReviewOutput each embed it, so a
// caller reads the same fields — token accounting, the raw envelope, the
// relayed transcript — regardless of which of the three activities produced
// them.
//
// It deliberately does not carry a work.Credential or any part of one.
// Activity results are written to workflow history and kept for the
// namespace's whole retention.
type stageOutput struct {
	// Output is the raw result envelope, kept because it is what the transcript
	// and any later forensics want.
	Output []byte

	// Result is the stage-specific output decoded out of that envelope. Its
	// underlying value is documented on the stage's own output type — for
	// example RunImplementOutput's doc comment says to read a
	// work.ImplementOutput out of it — and it is what a later turn's prompt is
	// rendered from, once the workflow appends it to Prior.
	Result work.StageOutput

	ThreadID string
	Usage    work.Usage

	// Transcript remains solely for decoding pre-AgentWorkflow activity results.
	Transcript work.Transcript
}

// StageAttempt is the one caller-facing shape behind RunPlanInput,
// RunImplementInput and RunReviewInput. It is exported, unlike stageInput
// itself, purely so a workflow — necessarily in another package — can build
// one: an unexported embedded field cannot be named in a composite literal
// outside this package, so NewRunPlanInput/NewRunImplementInput/
// NewRunReviewInput below are the only way in from internal/workflows.
type StageAttempt struct {
	Key     work.StageKey
	Sandbox work.SandboxID
	Model   work.Model
	Detail  work.TicketDetail
	Prior   work.PriorTurns
}

// NewRunPlanInput builds the plan stage's one attempt.
func NewRunPlanInput(attempt StageAttempt) RunPlanInput {
	return RunPlanInput{stageInput: stageInput(attempt)}
}

// NewRunImplementInput builds one implement turn's attempt.
func NewRunImplementInput(attempt StageAttempt) RunImplementInput {
	return RunImplementInput{stageInput: stageInput(attempt)}
}

// NewRunReviewInput builds one review turn's attempt.
func NewRunReviewInput(attempt StageAttempt) RunReviewInput {
	return RunReviewInput{stageInput: stageInput(attempt)}
}

// RunPlanInput is the plan attempt. There is only ever one per run: plan does
// not loop under this pipeline.
type RunPlanInput struct{ stageInput }

// RunPlanOutput is what the plan stage produced. Result's underlying value is
// always a work.DocumentOutput.
type RunPlanOutput struct{ stageOutput }

// UnmarshalJSON decodes a plan activity result, refusing any key this struct
// has no field for — see the shared reasoning on stageOutputUnmarshalJSON.
func (o *RunPlanOutput) UnmarshalJSON(data []byte) error {
	return stageOutputUnmarshalJSON(data, &o.stageOutput)
}

// RunImplementInput is one implement turn.
type RunImplementInput struct{ stageInput }

// RunImplementOutput is what one implement turn produced. Result's underlying
// value is always a work.ImplementOutput — read Blocked, BlockedReason, Title
// and Body off it; there is deliberately no duplicate copy of those fields
// here, so a caller has exactly one place to look, the same place it already
// has to look to append this turn onto Prior for the next one.
type RunImplementOutput struct{ stageOutput }

// UnmarshalJSON decodes an implement activity result, refusing any key this
// struct has no field for — see the shared reasoning on
// stageOutputUnmarshalJSON.
func (o *RunImplementOutput) UnmarshalJSON(data []byte) error {
	return stageOutputUnmarshalJSON(data, &o.stageOutput)
}

// RunReviewInput is one review turn.
type RunReviewInput struct{ stageInput }

// RunReviewOutput is what one review turn produced. Result's underlying value
// is always a work.ReviewOutput — read Findings off it; there is deliberately
// no duplicate copy of them here, for the reason RunImplementOutput gives.
type RunReviewOutput struct{ stageOutput }

// UnmarshalJSON decodes a review activity result, refusing any key this
// struct has no field for — see the shared reasoning on
// stageOutputUnmarshalJSON.
func (o *RunReviewOutput) UnmarshalJSON(data []byte) error {
	return stageOutputUnmarshalJSON(data, &o.stageOutput)
}

// stageOutputUnmarshalJSON is RunPlanOutput's, RunImplementOutput's and
// RunReviewOutput's shared UnmarshalJSON body.
//
// This is the workflow-history migration boundary, and the strictness is the
// point. The SDK's JSONPayloadConverter decodes an activity result with a
// plain json.Unmarshal, which ignores unrecognised keys — so a field rename or
// removal would otherwise decode a pre-deploy payload without error and leave
// the changed field at its zero value. work.StageOutput's own UnmarshalJSON
// cannot catch that on its own: it only runs when a "Result" key is present,
// and a pre-deploy payload might have none. A run in flight across such a
// deploy would replay as though a completed stage had produced nothing and
// fail later, somewhere unrelated, as a missing-prior error rather than a
// decode error naming the real mismatch.
//
// The cost is that removing or renaming a field on any of the three becomes a
// loud break for in-flight runs, which is the intended trade: adding a field
// stays compatible, because an absent key is not an unknown one.
func stageOutputUnmarshalJSON(data []byte, out *stageOutput) error {
	// A distinct type so decoding does not re-enter this method. Its fields,
	// and therefore work.StageOutput's own UnmarshalJSON, are unaffected.
	type wire stageOutput

	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()

	var w wire
	if err := dec.Decode(&w); err != nil {
		return fmt.Errorf("reading a stage activity result: %w", err)
	}
	*out = stageOutput(w)
	return nil
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

// FindPullRequest asks GitHub what already exists on a run's branch.
//
// It comes from GitHub rather than from what a stage's own report said it did:
// a stage's report is model output derived from issue text an attacker chose,
// and GitHub's answer about a branch the worker named is not. Under the
// pipeline rewrite (#435) this is called before every OpenOrUpdatePullRequest,
// so the workflow knows whether to create or edit, and once more at the run's
// end to read the PR whichever terminal path needs.
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

// OpenOrUpdatePullRequestInput is one push, asked to become — or stay — the
// run's pull request.
type OpenOrUpdatePullRequestInput struct {
	Branch string
	Title  string
	Body   string

	// Existing is nil the first time this run's branch has anything pushed to
	// it, and what FindPullRequest already found on every push after that. It
	// is passed in rather than re-queried here: the workflow already asked.
	Existing *work.PullRequest
}

// OpenOrUpdatePullRequest opens the run's pull request the first time its
// branch has anything pushed, and edits its title/body on every later push
// that changed them. PR ownership is code now, not the model (#435): a pull
// request opens after the first successful push and is never held back
// waiting for CI or review to conclude.
func (a *Activities) OpenOrUpdatePullRequest(ctx context.Context, in OpenOrUpdatePullRequestInput) (work.PullRequest, error) {
	pr, err := a.deps.GitHub.OpenOrUpdatePullRequest(ctx, in.Branch, in.Title, in.Body, in.Existing)
	if err != nil {
		return work.PullRequest{}, fail(ctx, fmt.Sprintf("opening or updating the pull request on %s", in.Branch), err)
	}
	return pr, nil
}

// ConvertPullRequestToDraft makes a declined pull request safe to leave behind.
func (a *Activities) ConvertPullRequestToDraft(ctx context.Context, nodeID string) error {
	if err := a.deps.GitHub.ConvertPullRequestToDraft(ctx, nodeID); err != nil {
		return fail(ctx, fmt.Sprintf("converting pull request %s to draft", nodeID), err)
	}
	return nil
}

// MarkPullRequestReadyForReview makes a proposed pull request reviewable.
func (a *Activities) MarkPullRequestReadyForReview(ctx context.Context, nodeID string) error {
	if err := a.deps.GitHub.MarkPullRequestReadyForReview(ctx, nodeID); err != nil {
		return fail(ctx, fmt.Sprintf("marking pull request %s ready for review", nodeID), err)
	}
	return nil
}

// MergePullRequestInput identifies the reviewed pull-request head GitHub may merge.
type MergePullRequestInput struct {
	PullRequestNumber int
	ExpectedHeadSHA   string
}

// MergePullRequest asks GitHub to squash-merge exactly the reviewed head.
//
// Semantic merge feedback is a typed result for the target workflow to route.
// Transport, authentication, ruleset, and rate-limit errors still flow through
// fail so Temporal retains the service's established retry classification.
func (a *Activities) MergePullRequest(ctx context.Context, in MergePullRequestInput) (work.PullRequestMergeResult, error) {
	result, err := a.deps.GitHub.MergePullRequest(ctx, in.PullRequestNumber, in.ExpectedHeadSHA)
	if err != nil {
		return work.PullRequestMergeResult{}, fail(ctx, fmt.Sprintf("squash-merging pull request #%d", in.PullRequestNumber), err)
	}
	return result, nil
}

// EnablePullRequestAutoMerge arms a proposed pull request to squash-merge
// itself once Calum approves it and its checks are green.
func (a *Activities) EnablePullRequestAutoMerge(ctx context.Context, nodeID string) error {
	if err := a.deps.GitHub.EnablePullRequestAutoMerge(ctx, nodeID); err != nil {
		return fail(ctx, fmt.Sprintf("enabling auto-merge on pull request %s", nodeID), err)
	}
	return nil
}

// PostPullRequestComment posts a run's full decline detail on its pull
// request.
//
// It reuses PostStatus rather than adding a new client method: a pull request
// is an issue to GitHub's REST API for commenting purposes, and a body
// carrying no status marker is exactly the "post a plain comment" case
// PostStatus already falls through to (github.Client.PostStatus) — this
// comment is never edited later, so there is nothing here for a marker to
// let a retry adopt.
func (a *Activities) PostPullRequestComment(ctx context.Context, pullRequest int, body string) error {
	if err := a.deps.GitHub.PostComment(ctx, pullRequest, body); err != nil {
		return fail(ctx, fmt.Sprintf("posting a comment on pull request #%d", pullRequest), err)
	}
	return nil
}
