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

// SandboxID identifies one ticket's disposable pod.
type SandboxID string

// CommentID identifies the single status comment a run edits in place.
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
	Image        string

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
