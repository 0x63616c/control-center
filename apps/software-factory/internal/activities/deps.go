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

	// InstallationToken mints a short-lived token scoped to this repository,
	// for the sandbox to push with.
	//
	// Its result must not be returned to a workflow: Temporal writes activity
	// results to history, so a token that crosses that boundary is persisted
	// for the namespace's whole retention. Call this inside the activity that
	// writes the token into the sandbox.
	InstallationToken(ctx context.Context) (work.Credential, error)
}

// TokenSource yields a currently-valid model access token.
//
// One method hides the whole of the credential problem: expiry, the OAuth
// refresh, the single-use rotation of the refresh token, and persisting the
// rotated value before it is used. Callers never see a refresh token, which is
// what lets a sandbox be handed a credential file with that field blanked.
type TokenSource interface {
	AccessToken(ctx context.Context) (work.Credential, error)
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
