// Package activities holds everything this service does that touches the world
// — the model, the Kubernetes API, GitHub, the clock, the filesystem — and
// declares the interfaces it needs to do it.
//
// The interfaces live here rather than beside their implementations because
// this is where they are consumed: each names only the methods this package
// uses, so a fake in a test implements a handful of methods rather than a
// client's whole surface. Clients return concrete types and know nothing about
// these declarations.
package activities

import (
	"context"
	"io"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/telemetry"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// DispatcherStateWriter records the dispatcher's per-tick projection (#551) —
// the store's own interface, restated here because this package declares
// every seam it consumes rather than depending on store.Store directly.
type DispatcherStateWriter interface {
	PutDispatcherState(ctx context.Context, state store.DispatcherState) error
}

// StageRunner executes one pipeline stage in a sandbox and returns its
// structured result. It is the only seam here that is not CRUD, and everything
// difficult about this service is behind it.
//
// An implementation composes: write the prompt and schema into the sandbox,
// build an explicit argv, exec it, stream the event lines to events while the
// enclosing activity heartbeats on them, and extract the token usage, the
// provider's thread ID and the schema-conforming final message.
//
// It must be idempotent. Activities retry, so an implementation reads a
// completed result when it is present and runs only when it is absent. The
// Session host owns the stage subprocess, so cancellation does not leave a
// separate process for a retry to observe.
//
// The result is read from a file rather than from the process's stdout because
// it is the durable completion record when a model invocation finishes before
// its activity reports success.
type StageRunner interface {
	RunStage(ctx context.Context, run work.StageRun, events work.StageEventSink) (work.StageResult, error)
}

// PodLifecycle creates and destroys per-ticket sandboxes.
//
// Create returns before the sandbox is usable, and WaitReady is separate,
// deliberately: a single call that blocked until ready would have no way to
// return the identifier of a pod it created but could not wait for, and would
// leak it. Splitting them means the caller always holds the ID it needs to
// clean up.
//
// Create's codexCredential parameter is D3's (#434) credential transport: an
// implementation writes it into a per-ticket Kubernetes Secret and mounts
// that Secret into the pod it builds, before the pod exists — never as a
// Temporal activity payload, and never returned from Create. Delete removes
// that Secret alongside the pod it mounted into, symmetric with Create.
type PodLifecycle interface {
	Create(ctx context.Context, spec work.SandboxSpec, codexCredential work.CredentialFile) (work.SandboxID, error)
	WaitReady(ctx context.Context, sandbox work.SandboxID) error
	Delete(ctx context.Context, sandbox work.SandboxID) error
}

// GitHub is this service's view of the issue tracker: the tickets it may work,
// the status it reports, and the credential a sandbox needs to push a branch.
//
// The methods are narrow on purpose. There is no generic label writer — this
// system only clears `auto` and marks failed runs with `failed`. There is no
// Comment/EditComment pair either:
// a run posts one status comment per step of its own pipeline and edits that
// step's comment in place, so the type says PostStatus and EditStatus and
// cannot express arbitrary commenting.
type GitHub interface {
	// PostComment adds a comment to an issue or pull request. Pull requests
	// use GitHub's issues endpoint for comments, so number is the resource's
	// shared number in either case.
	PostComment(ctx context.Context, number int, body string) error

	// PullRequestForBranch reports the open pull request on a branch, if there
	// is one.
	//
	// This is how a run learns what already exists on its own branch, and the
	// reason it is asked of GitHub rather than read out of a stage's own
	// report: a stage's report is model output derived from issue text an
	// attacker chose, and a URL taken from it is a phishing vector rendered as
	// an autolink (#371). GitHub's answer about a branch we named ourselves
	// cannot be forged by anyone who can file an issue.
	//
	// Absence is a real answer, not an error — under the pipeline rewrite
	// (#435), PR ownership is workflow code: OpenOrUpdatePullRequest creates
	// on Found: false and edits on Found: true, so absence here just picks
	// which of those two happens next.
	PullRequestForBranch(ctx context.Context, branch string) (pr work.PullRequest, found bool, err error)

	// InstallationToken mints a short-lived token scoped to this repository,
	// for the sandbox to push with.
	//
	// Its result must not be returned to a workflow: Temporal writes activity
	// results to history, so a token that crosses that boundary is persisted
	// for the namespace's whole retention. Call this inside the activity that
	// writes the token into the sandbox.
	InstallationToken(ctx context.Context) (work.SandboxCredential, error)

	// OpenOrUpdatePullRequest opens the run's pull request the first time its
	// branch has anything pushed, and edits it on every later push that
	// changed its title or body. existing is nil the first time; every push
	// after that it is what a prior PullRequestForBranch call already found,
	// so this never looks twice.
	OpenOrUpdatePullRequest(ctx context.Context, branch, title, body string, existing *work.PullRequest) (work.PullRequest, error)

	// ConvertPullRequestToDraft marks a pull request as a draft. It takes the
	// pull request's GraphQL node id, not its REST number — see
	// work.PullRequest.NodeID.
	ConvertPullRequestToDraft(ctx context.Context, nodeID string) error

	// MarkPullRequestReadyForReview makes a draft pull request reviewable.
	MarkPullRequestReadyForReview(ctx context.Context, nodeID string) error

	// MergePullRequest asks GitHub to squash-merge exactly expectedHeadSHA.
	// Its typed result distinguishes semantic feedback from a confirmed merge.
	MergePullRequest(ctx context.Context, number int, expectedHeadSHA string) (work.PullRequestMergeResult, error)

	// EnablePullRequestAutoMerge arms a pull request to squash-merge itself
	// once its required approval and checks are satisfied. Callers must only
	// call this once the pull request is already out of draft.
	EnablePullRequestAutoMerge(ctx context.Context, nodeID string) error

	// ChecksForRef returns every check run GitHub has recorded against ref —
	// a branch name, in this service's only caller — as one snapshot. It
	// takes no view on whether they have concluded or passed:
	// Activities.ObserveCI is what polls this repeatedly and reduces the
	// snapshot into concluded/green/red for the implement/review loop's
	// progress-detection rules, so this stays a single request, symmetric
	// with PullRequestForBranch.
	ChecksForRef(ctx context.Context, ref string) ([]work.CheckRun, error)

	// ChecksForCommit returns required check runs for an exact immutable commit
	// SHA. Target AwaitCI must not substitute a branch or later head.
	ChecksForCommit(ctx context.Context, commitSHA string, requiredChecks []string) ([]work.CheckRun, error)
}

// RepoCloner checks the ticket's repository out inside its sandbox, on the
// branch this run named, and pushes it. Nothing else in this service puts a
// repository in the sandbox, so every stage depends on this running first:
// codex refuses to run outside a git repository and exits before making any
// model call, which without a checkout would fail every stage identically and
// read as the model failing the ticket rather than as a missing repository.
//
// The branch it checks out is read from the sandbox's own environment, never
// recomputed: work.SandboxTemplate.Spec baked SF_BRANCH into the pod at create
// time, and an implementation that asked the sandbox for that value rather
// than calling work.BranchName a second time is the one that notices if those
// two ever disagree.
//
// It is idempotent under activity retry, in the same shape as StageRunner: an
// existing checkout already on this run's branch is left alone, and a push is
// issued regardless, which is a no-op against a branch already at that state.
type RepoCloner interface {
	// CloneRepo clones cloneURL into the sandbox, authenticating with
	// credential, and pushes the branch the sandbox's own environment names.
	//
	// credential is never returned or logged — it is used only to authenticate
	// the clone and the push, for the same reason InstallationToken's result
	// must not reach a workflow: Temporal would persist it to history for the
	// namespace's whole retention.
	CloneRepo(ctx context.Context, sandbox work.SandboxID, cloneURL string, credential work.SandboxCredential) error
}

// TokenSource yields the credential document to write into a sandbox.
//
// One method hides the whole of the credential problem: expiry, the OAuth
// refresh, the single-use rotation of the refresh token, persisting the rotated
// value before it is used — and the codex CLI's own file format.
//
// It yields a whole file rather than an access token because a sandbox's
// auth.json composed from a token alone does not merely go unscoped, it FAILS
// TO PARSE, and codex exec never starts. What makes it parse is a set of
// non-uniform serde attributes on a Rust struct (id_token mandatory and
// JWT-parsed, OPENAI_API_KEY present-but-nullable, refresh_token
// present-but-blankable). Those are facts about codex, so they live in the one
// package that has read its source; a caller assembling the JSON would have to
// know them, and would drift from them.
//
// The returned document always has its refresh token blanked, so a caller
// cannot leak one it never receives. There is deliberately no method returning
// a bare token: nothing needs one today, and absent API surface is a stronger
// guarantee than a documented convention.
type TokenSource interface {
	SandboxCredentialFile(ctx context.Context) (work.CredentialFile, error)
}

// PromptRenderer turns a ticket and the preceding stage's output into the
// prompt and schema one stage runs on.
//
// It is a seam rather than a call into internal/prompts because prompts are the
// highest-churn part of this service and orchestration is the lowest: a wording
// change must not be a workflow change, and a test of the pipeline must not
// need the real prompts to exist. It is also the rule the linter enforces —
// workflow code may not import internal/prompts at all, because the nonce a
// render mints is invisible nondeterminism at the call site.
//
// The workflow itself still reads nothing back from a stage's PROSE — ticket
// bodies are attacker-chosen and they reach a model, so no stage's document
// may steer control flow, and what a run achieved on GitHub is still asked of
// GitHub. See GitHub.PullRequestForBranch. What the workflow's own loop *does*
// read, since the pipeline rewrite (#435): implement's Blocked/BlockedReason
// and review's Findings, both real structured data constrained by
// --output-schema rather than free text, never re-parsed prose. See
// work.ImplementOutput and work.ReviewOutput.
type PromptRenderer interface {
	// Render returns the prompt a stage runs on and the schema its final
	// message must satisfy — one schema per stage, not a single shared
	// envelope, so a required field like implement's Blocked is stated for
	// the stage that actually answers it.
	//
	// prior is exactly the plan, the latest implement turn and the latest
	// review turn — see work.PriorTurns' own doc comment for why the seam
	// is bounded to that rather than the run's whole turn history. The
	// workflow (internal/workflows) keeps the full history in its own local
	// state, for progress detection; it narrows to this before building an
	// activity input, because Temporal records this input into workflow
	// history on every single stage invocation, and the whole history would
	// otherwise be shipped, and re-shipped, on every turn. The one bounded
	// exception is work.PriorTurns.ReviewLedger; its own doc comment says why
	// review can hold a whole-run memory when implement cannot.
	//
	// key rather than a bare stage, because a prompt can depend on WHICH turn
	// of that stage it is: review is told it is turn N of
	// work.MaxReviewTurns, so a turn can weigh a blocking finding against
	// being the last turn the run will get.
	Render(key work.StageKey, detail work.TicketDetail, prior work.PriorTurns, promptContext work.AgentPromptContext) (prompt string, schema []byte, err error)

	// Decode unwraps a stage's result envelope into the domain's StageOutput.
	//
	// It belongs beside Render because they are one format seen from two ends:
	// whoever defines the envelope a stage answers in is the only one who can
	// say what its answer means. It is not a verdict in the sense that mattered
	// before this type existed — Blocked/BlockedReason on implement's output is
	// real branchable data, not prose to be re-parsed, but it is not derived
	// from ticket text either: it is the model's own structured self-report,
	// constrained by --output-schema. What still never branches on this is the
	// workflow's own outcome decision, which continues to ask GitHub rather
	// than trust any stage's output — see GitHub.PullRequestForBranch.
	Decode(stage work.Stage, result []byte) (work.StageOutput, error)
}

// RunLookup answers whether a ticket's workflow is still open.
//
// It is DescribeWorkflowExecution and nothing else: a point lookup by workflow
// ID, strongly consistent. Deliberately not a visibility query — visibility is a
// search index and eventually consistent, and using it to decide whether a slot
// is free would be a race dressed as a query.
type RunLookup interface {
	Describe(ctx context.Context, workflowID string) (work.RunState, error)
}

// SandboxSweeper deletes sandbox pods no run owns any more.
//
// A worker that dies mid-ticket leaves its pod behind, and nothing else in the
// system is positioned to notice: the workflow that would have cleaned up is
// the thing that died. live is the set of run IDs the dispatcher believes are
// working, and minAge is the margin below which a pod is left alone whatever
// live says — without it the sweep races the run that just created it.
type SandboxSweeper interface {
	SweepOrphans(ctx context.Context, live []string, minAge time.Duration) (deleted int, err error)
}

// TranscriptSink stores one stage attempt's raw event stream.
//
// It takes a StageKey and returns a writer, so the path layout stays in one
// place and no caller assembles it. Transcripts are stored rather than logged
// because the cluster's log retention is far shorter than the time you might
// want to ask why a PR was proposed.
type TranscriptSink interface {
	Open(ctx context.Context, key work.StageKey) (io.WriteCloser, error)
}

// Metrics records what a stage attempt spent and how it ended.
//
// It is an interface here, satisfied by *telemetry.Metrics, for one reason
// beyond testability: telemetry.NewMetrics registers with Prometheus and
// **panics on duplicate registration**, deliberately — two counter sets each
// recording half the work is worse than a crash. So there is exactly one
// construction, in the composition root, and this package accepts what it is
// handed rather than being able to construct a second.
//
// Recording is fire-and-forget: it returns nothing, because failing a stage
// that has already spent its tokens in order to report that it spent them
// would be the tail wagging the dog.
type Metrics interface {
	StageFinished(stage work.Stage, model work.Model, outcome telemetry.Outcome, usage work.Usage, took time.Duration)
}
