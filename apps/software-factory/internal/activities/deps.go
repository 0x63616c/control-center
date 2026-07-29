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

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/telemetry"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// StageRunner executes one pipeline stage in a sandbox and returns its
// structured result. It is the only seam here that is not CRUD, and everything
// difficult about this service is behind it.
//
// An implementation composes: write the prompt and schema into the sandbox,
// build an explicit argv, exec it, stream the event lines to events while the
// enclosing activity heartbeats on them, and extract the token usage, the
// provider's thread ID and the schema-conforming final message.
//
// It must be idempotent. Activities retry, and a retry can begin while the
// previous attempt's process is still alive in the sandbox, so an
// implementation decides between running, attaching and reading a stored result
// from what the previous attempt left behind — never by assuming it is first.
//
// The result is read from a file rather than from the process's stdout, because
// only a file survives the worker dying between the model finishing and the
// worker noticing.
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
type PodLifecycle interface {
	Create(ctx context.Context, spec work.SandboxSpec) (work.SandboxID, error)
	WaitReady(ctx context.Context, sandbox work.SandboxID) error
	Delete(ctx context.Context, sandbox work.SandboxID) error
}

// GitHub is this service's view of the issue tracker: the tickets it may work,
// the status it reports, and the credential a sandbox needs to push a branch.
//
// The methods are narrow on purpose. There is no RemoveLabel(issue, label) —
// `auto` is the only label this system touches, and a general method would be
// an invitation to touch others. There is no Comment/EditComment pair either:
// a run posts one status comment per step of its own pipeline and edits that
// step's comment in place, so the type says PostStatus and EditStatus and
// cannot express arbitrary commenting.
type GitHub interface {
	// ListAutoTickets returns the open issues labelled `auto`. The label means
	// this ticket wants machine work and none has been delivered.
	ListAutoTickets(ctx context.Context) ([]work.Ticket, error)

	// TicketDetail returns one ticket with the discussion on it: what was
	// asked, plus the corrections that arrived afterwards. A plan built from
	// the issue body alone is a plan built from the first draft of the ask.
	//
	// By number rather than "the ticket being worked", because the stage that
	// follows a reference in an issue body needs exactly this, for a different
	// issue. It reads and writes nothing, which is why it does not widen what
	// this seam can DO — the narrowness the rest of this interface is built for
	// is about writes.
	TicketDetail(ctx context.Context, number int) (work.TicketDetail, error)

	// PostStatus opens one of the run's status comments, or adopts it if this
	// run already opened it. The body carries the marker that says which.
	PostStatus(ctx context.Context, issue int, body string) (work.CommentID, error)

	// EditStatus rewrites that comment in place as the run progresses.
	EditStatus(ctx context.Context, id work.CommentID, body string) error

	// ClearAutoLabel removes `auto`, which the machine does when it has opened
	// a PR or given up. A human re-adds it to request another pass.
	ClearAutoLabel(ctx context.Context, issue int) error

	// PullRequestForBranch reports the open pull request on a branch, if there
	// is one.
	//
	// This is how a run learns what it achieved, and the reason it is asked of
	// GitHub rather than read out of the propose stage's own report: the
	// stage's report is model output derived from issue text an attacker chose,
	// and a URL taken from it is a phishing vector rendered as an autolink
	// (#371). GitHub's answer about a branch we named ourselves cannot be
	// forged by anyone who can file an issue.
	//
	// Absence is a real answer, not an error — a propose stage that declined to
	// open a pull request is a run that was blocked, which is a decision rather
	// than a failure.
	PullRequestForBranch(ctx context.Context, branch string) (pr work.PullRequest, found bool, err error)

	// InstallationToken mints a short-lived token scoped to this repository,
	// for the sandbox to push with.
	//
	// Its result must not be returned to a workflow: Temporal writes activity
	// results to history, so a token that crosses that boundary is persisted
	// for the namespace's whole retention. Call this inside the activity that
	// writes the token into the sandbox.
	InstallationToken(ctx context.Context) (work.Credential, error)
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
// It reads nothing back. An earlier design had a companion Verdict method that
// parsed a stage's output for "blocked" and a pull request URL; that is gone
// deliberately. No stage's TEXT may steer control flow — ticket bodies are
// attacker-chosen and they reach a model — so what a run achieved is asked of
// GitHub instead. See GitHub.PullRequestForBranch.
type PromptRenderer interface {
	// Render returns the prompt a stage runs on and the schema its final
	// message must satisfy. handoff is the preceding stage's output, verbatim
	// and unparsed, or nil for the first stage.
	Render(stage work.Stage, detail work.TicketDetail, handoff []byte) (prompt string, schema []byte, err error)
}

// StatusRenderer turns a run's state into the body of its status comment.
//
// Separate from the thing that posts it for the same reason: the wording of a
// status comment changes far more often than the decision to report one.
type StatusRenderer interface {
	Render(report work.StatusReport) string
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
