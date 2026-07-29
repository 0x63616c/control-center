// Package work holds the domain vocabulary of autonomous ticket work: the
// ticket, the stages it passes through, the sandbox a stage runs in, and what a
// stage produces. Every seam in this service is expressed in these types, so no
// third-party worldview — Kubernetes, GitHub or codex — crosses a module edge.
package work

import (
	"errors"
	"fmt"
)

// ErrFileNotFound reports that a path does not exist inside a sandbox.
//
// It is not merely an error code: absence is the signal a stage keys off to
// decide whether it has already run, so implementations must distinguish "no
// such file" from "could not tell" and never collapse the two. Compare with
// errors.Is.
var ErrFileNotFound = errors.New("file not found in sandbox")

// ErrPermanent marks an error that a retry cannot fix, so a caller stops paying
// for attempts that were never going to work.
//
// It is one bit, and it is deliberately the only one. Retry semantics belong to
// Temporal's taxonomy, not a domain one — but a client cannot import the
// Temporal SDK without breaking the seal that keeps an SDK's worldview out of
// the rest of this service. So the single bit Temporal needs travels as domain
// vocabulary and is translated exactly once, in internal/activities, into a
// non-retryable ApplicationError. Anything unmarked is retryable, which is
// Temporal's default.
//
// That translation site is the reason not to grow this into a rival scheme. An
// error-kind enum, a Retryable() method or a second marker would be the
// parallel taxonomy this exists to avoid, and would have to be reconciled with
// Temporal's at the same boundary. Wrap with %w; compare with errors.Is.
var ErrPermanent = errors.New("permanent failure")

// ErrSecretNotFound reports that a stored secret does not exist.
//
// Absence is a signal, never a failure to read: the credential secret is seeded
// by a human out of band, so "it is not there" means somebody has a job to do,
// while "I could not tell" means try again shortly. An implementation that
// collapsed the two would turn a transient apiserver blip into a demand for a
// browser login. Compare with errors.Is.
var ErrSecretNotFound = errors.New("secret not found")

// ErrVersionConflict reports that a stored object changed between a read and
// the write derived from it, and that the write was therefore not applied.
//
// It says only that, deliberately. Whether a conflict is contention worth
// retrying or an invariant already violated depends entirely on what the caller
// had done by the time it fired — a lease loser retries, a rotation that has
// already spent its single-use refresh token cannot.
var ErrVersionConflict = errors.New("stored object changed since it was read")

// ErrNoPrecondition reports that a write named no precondition at all: the
// version handed to it was never set, or was dropped on the way.
//
// It is separate from ErrVersionConflict because the two are opposite
// instructions. A conflict is news about another writer and may be worth
// retrying; this is the caller's own bug, and retrying it changes nothing.
// Compare with errors.Is.
var ErrNoPrecondition = errors.New("write names no precondition")

// SecretVersion is the state a read of a stored object observed, and the
// precondition a write derived from that read applies to it.
//
// It is a struct rather than a string because the obvious spelling is unsafe.
// Kubernetes treats an empty resourceVersion on an update as an unconditional
// overwrite that never conflicts, so with a bare string a dropped return value
// or an unset field disarms a compare-and-swap silently, leaving code that
// reads exactly like a lease and enforces nothing. Here the empty string is
// reachable only through Unconditional, and the zero value has no way to
// produce one at all — see Precondition.
type SecretVersion struct {
	token         string
	unconditional bool
}

// ObservedVersion is the precondition "unchanged since this token was read".
// Implementations mint one from whatever their store calls a version; an empty
// token yields the zero value, because a store that cannot say what it read
// cannot constrain a write.
func ObservedVersion(token string) SecretVersion {
	return SecretVersion{token: token}
}

// Unconditional is the precondition "none": the write overwrites whatever is
// there. It exists so that overwriting blind is a thing a caller asks for
// rather than a thing a caller forgets.
func Unconditional() SecretVersion {
	return SecretVersion{unconditional: true}
}

// Precondition returns the store's own version string for a write to apply,
// and ErrNoPrecondition if this version names none.
//
// It is the only way out of the type, and it returns an error so that the
// refusal is mechanical rather than remembered. The natural implementation
// assigns whatever it is given straight onto the write it is about to make; if
// the zero value could answer that question at all it would answer "", which
// Kubernetes reads as an unconditional overwrite, and the compare-and-swap
// would be gone with nothing to see at the call site. Ignoring the error here
// fails errcheck, so the mistake stops at lint rather than at a spent refresh
// token.
//
// An empty string is therefore a deliberate blind write and nothing else: only
// Unconditional can produce one.
func (v SecretVersion) Precondition() (resourceVersion string, err error) {
	if v.token == "" && !v.unconditional {
		return "", ErrNoPrecondition
	}
	return v.token, nil
}

// Stage is one step of the pipeline.
type Stage string

// The stages of a run, in pipeline order.
const (
	// StagePlan turns a ticket into an implementation plan.
	StagePlan Stage = "plan"
	// StageReview adversarially critiques that plan from a fresh thread.
	StageReview Stage = "review"
	// StageRevise folds the critique back into the plan.
	StageRevise Stage = "revise"
	// StageImplement writes the code and pushes the branch.
	StageImplement Stage = "implement"
	// StagePropose opens the pull request and stops.
	StagePropose Stage = "propose"
)

// Pipeline is the order stages run in, and the single source of truth for that
// order. It returns a fresh slice per call so no caller can reorder another's.
func Pipeline() []Stage {
	return []Stage{StagePlan, StageReview, StageRevise, StageImplement, StagePropose}
}

// Ticket is a GitHub issue eligible for machine work.
//
// Title and Body are attacker-controllable: anyone who can file an issue
// chooses them. They reach a model as prompt content and a sandbox as file
// content. They must never reach a shell, a command argument, a Kubernetes
// object or a filesystem path — which is why the types that touch those things
// take a ticket number rather than this struct.
type Ticket struct {
	// Number is the GitHub issue number and the identity of the whole run.
	Number int
	Title  string
	Body   string
}

// TicketComment is one comment on a ticket's thread.
//
// Author and Body are attacker-controllable for exactly the reason Ticket's
// are, and one step further: anyone who can comment on an issue chooses Body,
// and no membership is required to comment on a public repository's issue. It
// carries the same prohibition — never a shell, a command argument, a
// Kubernetes object or a filesystem path.
type TicketComment struct {
	// Author is the commenter's GitHub login. It is here so a reader — human or
	// model — can weigh who said something, not so anything can authorise on it.
	Author string
	Body   string
}

// TicketDetail is a ticket together with the discussion on it: what the ticket
// asks for, plus the corrections and clarifications that arrived afterwards.
//
// It is a separate type from Ticket rather than more fields on it, because the
// two are read at different prices and by different callers. Listing eligible
// tickets is a poll that runs every few seconds and needs one request per page;
// a thread costs its own paged read per ticket. Folding them together would
// make the poll either pay for threads nobody asked for, or hand back a Ticket
// whose empty Comments means "none" and "not fetched" at once.
//
// The run's own status comments are not in Comments. It posts one per step and
// edits them as it goes, and a planner handed those reads our progress updates
// back as requirements.
type TicketDetail struct {
	Ticket

	// Comments is the thread in the order it was written, oldest first.
	Comments []TicketComment

	// CommentsOmitted counts the comments dropped from the middle of a thread
	// too long to carry. It is a field rather than a silent truncation so a
	// caller rendering this into a prompt can say the thread was trimmed —
	// which is the difference between a model knowing it lacks context and a
	// model believing it has all of it.
	CommentsOmitted int
}

// SandboxID identifies one ticket's disposable pod.
type SandboxID string

// CommentID identifies one status comment of a run, which the run edits in
// place as that step progresses.
type CommentID int64

// Model names the model and reasoning effort a stage runs at. Per-stage
// overrides exist so the adversarial reviewer can be given different blind
// spots from the planner without touching workflow code.
type Model struct {
	Name   string
	Effort string
}

// Usage is the token accounting for one stage, as reported by the model's own
// completion event. Tokens are the only cost this service spends, and they come
// out of the same subscription window as its owner's interactive sessions.
type Usage struct {
	InputTokens       int64
	CachedInputTokens int64
	OutputTokens      int64
	ReasoningTokens   int64
}

// Add returns the sum of two usages, so a run can total its stages.
func (u Usage) Add(other Usage) Usage {
	return Usage{
		InputTokens:       u.InputTokens + other.InputTokens,
		CachedInputTokens: u.CachedInputTokens + other.CachedInputTokens,
		OutputTokens:      u.OutputTokens + other.OutputTokens,
		ReasoningTokens:   u.ReasoningTokens + other.ReasoningTokens,
	}
}

// StageRun is one stage attempt: which attempt it is, and what to execute.
//
// Identity is the Key and nothing else. Everything else is payload, which is
// why they are separate types — the resume decision, the transcript and the
// stage's own files are all derived from the Key alone, and none of them should
// have to be handed a prompt to find out where they live.
//
// Note what is absent: no Ticket, so no attacker-controlled text. The prompt
// arrives already rendered, so a stage runner never interpolates issue text
// itself and cannot be the place an injection lands.
type StageRun struct {
	Key     StageKey
	Sandbox SandboxID
	Model   Model

	// Prompt is the fully rendered stage prompt, including any handoff from the
	// preceding stage. It is written to the sandbox as a file, never passed as
	// an argument.
	Prompt string

	// Schema is the JSON Schema constraining the stage's final message. It is
	// what makes a plan travel as data rather than as conversation.
	Schema []byte
}

// StageResult is what one stage produced.
type StageResult struct {
	// Output is the schema-conforming final message, still unparsed. Only the
	// caller knows which stage's schema it satisfies, so only the caller parses
	// it into a typed value.
	Output []byte

	// ThreadID is the model provider's own identifier for the conversation,
	// recorded so a stored transcript can be correlated with the provider's
	// records.
	ThreadID string

	Usage Usage
}

// StageEventSink receives each raw event line as a stage streams it.
//
// Each call carries exactly one whole event, verbatim and without a terminator.
// Framing has one owner: whoever stores the stream adds the terminator, so a
// producer that pre-terminated its lines would be visible rather than silently
// tolerated.
//
// One callback serves both consumers of that stream: the transcript, which
// needs the bytes verbatim, and the enclosing activity's heartbeat, which needs
// only to know that something happened. A stage that emits nothing for the
// heartbeat timeout is treated as dead rather than slow.
//
// It returns nothing, deliberately. A failed transcript write must not abort a
// stage that is already burning tokens: losing the record of the work is
// cheaper than losing the work.
type StageEventSink func(rawEvent []byte)

// SandboxSpec describes the pod one ticket's stages execute in. Its lifetime is
// the ticket's: nothing in it survives the run, and nothing valuable is in it.
//
// It carries the ticket NUMBER rather than the Ticket, so no attacker-chosen
// text can reach a Kubernetes object name, label or annotation.
type SandboxSpec struct {
	TicketNumber int

	// RunID is Temporal's RunID for the run this sandbox belongs to, the same
	// value and the same representation StageKey carries — one run id, not two
	// spellings of one.
	//
	// It belongs in the pod's name. A pod named for the ticket alone is shared
	// by every run of that ticket, so an AlreadyExists on Create could mean
	// either "my own Create is being retried" or "an older run left this
	// behind", and adopting the wrong one gives a run a pod built to a
	// different spec with someone else's deadline already ticking. Named for
	// the run too, AlreadyExists can only ever be the first case, and the spec
	// and deadline are right by construction. It is safe in a name for the same
	// reason the ticket number is: Temporal mints it, and it is a UUID, so no
	// issue author can steer it.
	RunID string

	Image string

	// CPULimit and MemoryLimit are Kubernetes quantity strings ("2", "4Gi").
	CPULimit    string
	MemoryLimit string

	// DeadlineSeconds is the hard ceiling Kubernetes enforces on the pod. It
	// sits above the workflow's own timeout, so Kubernetes never kills a pod
	// Temporal still believes in.
	DeadlineSeconds int64

	// Env is the sandbox's environment. It carries the ephemeral CODEX_HOME
	// path; it never carries a credential, which is written as a file instead.
	Env map[string]string
}

// Credential is a short-lived secret — a GitHub App installation token, or a
// model access token. It is deliberately not a string: the type is what stops
// the value reaching a log line or a durable store.
//
// It must never be returned from an activity. Temporal persists activity
// results to workflow history, so a token that crosses that boundary is written
// to the database and stays there for the namespace's whole retention. Fetch
// credentials inside the activity that uses them.
type Credential struct {
	value string
}

// NewCredential wraps a secret value.
func NewCredential(value string) Credential {
	return Credential{value: value}
}

// Reveal returns the underlying secret. Call it only at the point the value is
// written to its destination.
func (c Credential) Reveal() string {
	return c.value
}

// String redacts the credential, so a stray %v cannot leak it.
func (c Credential) String() string {
	return "[redacted]"
}

// LogValue redacts the credential in structured logs. slog prefers this over
// String, so without it a credential passed as a log attribute would print.
func (c Credential) LogValue() any {
	return "[redacted]"
}

// MarshalJSON always fails, and that is the point. Redacting instead would let
// a credential be serialised into workflow history or a Kubernetes object as
// the literal text "[redacted]" — a confusing runtime failure far from its
// cause. Failing here names the mistake at the moment it is made.
func (c Credential) MarshalJSON() ([]byte, error) {
	return nil, fmt.Errorf("refusing to serialise a Credential: fetch it inside the activity that uses it")
}
