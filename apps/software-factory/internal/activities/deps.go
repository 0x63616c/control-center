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
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// DispatcherStateWriter records the dispatcher's per-tick projection (#551) —
// the store's own interface, restated here because this package declares
// every seam it consumes rather than depending on store.Store directly.
type DispatcherStateWriter interface {
	PutDispatcherState(ctx context.Context, state store.DispatcherState) error
}

// PodLifecycle creates and destroys per-ticket sandboxes.
//
// Create returns before the sandbox is usable, and WaitReady is separate,
// deliberately: a single call that blocked until ready would have no way to
// return the identifier of a pod it created but could not wait for, and would
// leak it. Splitting them means the caller always holds the ID it needs to
// clean up.
type PodLifecycle interface {
	Create(ctx context.Context, spec work.SandboxSpec) (work.SandboxID, error)
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
// the repository tools are unavailable until the checkout exists, which
// without a checkout would fail every stage before useful work begins.
//
// The branch it checks out is read from the sandbox's own environment, never
// recomputed: work.SandboxTemplate.Spec baked SF_BRANCH into the pod at create
// time, and an implementation that asked the sandbox for that value rather
// than calling work.BranchName a second time is the one that notices if those
// two ever disagree.
//
// It is idempotent under activity retry: an
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
	// PushRepo publishes the committed branch with a freshly minted credential.
	PushRepo(ctx context.Context, sandbox work.SandboxID, cloneURL string, credential work.SandboxCredential) error
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
