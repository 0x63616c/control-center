package work

import (
	"fmt"
	"path"
	"strings"
)

// SandboxRoot is where a stage's working files live inside the sandbox.
//
// It is part of the contract with the sandbox image rather than a private
// detail of whatever runs the stage: the image's entrypoint creates it, and the
// worker writes into it. Changing it means changing both.
const SandboxRoot = "/work"

// RepoDir is where the ticket's repository is checked out inside the sandbox,
// and the directory a stage's `codex exec` must run in.
//
// It is a subdirectory of SandboxRoot rather than SandboxRoot itself, because
// the sandbox root also holds this run's scaffolding — .exec/ and the per-stage
// prompt, schema and result files. Checking the repository out over the top of
// those would put them inside the git working tree, where `implement` is one
// `git add -A` away from committing a prompt into the branch it pushes.
//
// **Nothing creates this directory ahead of the clone, deliberately.** The
// image cannot: /work is an emptyDir, which masks anything baked under it. The
// container runtime must not: a WORKDIR it has to create inside that emptyDir
// is created as root with mode 0755, and the sandbox uid then cannot write its
// own checkout — a permission error that reads as a broken tool. A directory
// the cloning process creates is owned by that process, so the clone creates
// it, and the image's WORKDIR stays at the group-writable SandboxRoot.
const RepoDir = SandboxRoot + "/repo"

// StageKey identifies one stage attempt, and is the whole of that identity.
//
// Every deterministic path a stage keys off is derived from these three fields
// and nothing else. That is what makes a stage idempotent under activity retry:
// a rescheduled activity computes the same paths, finds what the previous
// attempt left behind, and resumes instead of restarting.
//
// None of the three can carry attacker-controlled text — a ticket number is an
// integer, a Temporal RunID is a UUID, and a Stage is one of five constants —
// so the paths below cannot be steered by anything an issue author writes.
type StageKey struct {
	// Ticket is the GitHub issue number.
	Ticket int
	// RunID is Temporal's RunID for the enclosing workflow run. It scopes the
	// attempt so a retried or re-run ticket stays separately inspectable rather
	// than overwriting its own history.
	RunID string
	Stage Stage
}

// String names the attempt for logs and errors.
func (k StageKey) String() string {
	return fmt.Sprintf("ticket #%d stage %s run %s", k.Ticket, k.Stage, k.RunID)
}

// WorkflowID is the Temporal workflow ID for a ticket's run.
//
// Starting a workflow with this ID *is* the claim on the ticket: Temporal
// refuses a second execution with an open run under the same ID, so uniqueness
// here replaces a lease table or an advisory lock. Nothing else may construct
// this string — a second spelling would be a second claim.
//
// It assumes one repository. Working tickets from more than one would need the
// repository in the ID, and changing the scheme once runs are in flight would
// orphan open workflows and let their tickets be claimed twice, so that change
// costs a drain rather than a deploy.
func WorkflowID(ticketNumber int) string {
	return fmt.Sprintf("work-ticket-%d", ticketNumber)
}

// DispatcherWorkflowID is the one dispatcher's Temporal workflow ID.
//
// It is a constant rather than derived from anything, because there is
// exactly one dispatcher: the composition root starts a workflow with this ID
// on every boot, and Temporal's default StartWorkflowOptions — reused across
// an already-running execution rather than erroring on it — is what makes
// that idempotent. A second spelling anywhere would be a second dispatcher.
const DispatcherWorkflowID = "software-factory-dispatcher"

// statusMarkerPrefix opens every status marker. It carries a version so the
// grammar can change without a new run adopting an old run's comment by
// accident.
const statusMarkerPrefix = "<!-- software-factory:status v1 run="

// StatusStep names which of a run's status comments a marker identifies.
//
// A run appends a comment per step rather than editing one comment for the
// whole run, so the marker has to identify the comment and not merely the run:
// without the step, every step's create-or-adopt would match the first comment
// the run posted and the run would overwrite its own history.
type StatusStep string

// The steps that are not stages: a run opens with one and ends with one.
const (
	// StepPickup is the comment announcing the run and its Temporal run.
	StepPickup StatusStep = "pickup"
	// StepOutcome is the comment carrying the PR or the reason there is none,
	// plus the run's token totals.
	StepOutcome StatusStep = "outcome"
)

// StageStep is the step a stage's own status comment occupies.
//
// One comment per stage, not per attempt — the same identity StageKey carries.
// A retried stage therefore adopts and edits the comment it already posted
// rather than appending a second one for work the reader already saw start.
func StageStep(stage Stage) StatusStep {
	return StatusStep("stage-" + stage)
}

// StatusMarker is the first line of one status comment, and the only thing that
// identifies the comment as that run's, at that step.
//
// Nothing else may construct this string — a second spelling would be a second
// comment. It lives here rather than beside either the renderer that emits it
// or the client that matches it, because those are two packages and this is one
// fact; whichever of them owned it, the other would hold a copy.
//
// It is an HTML comment so it renders as nothing, and it carries the RunID so a
// previous run's status comments never match and stay on the issue as history.
func StatusMarker(runID string, step StatusStep) string {
	return statusMarkerPrefix + runID + " step=" + string(step) + " -->"
}

// StatusMarkerIn returns the marker line of a rendered status body.
//
// Only the first line counts. A human quoting a status comment reproduces its
// marker further down, and matching that would let a run adopt a comment it did
// not write.
func StatusMarkerIn(body string) (string, bool) {
	line, _, _ := strings.Cut(body, "\n")
	if !strings.HasPrefix(line, statusMarkerPrefix) || !strings.HasSuffix(line, " -->") {
		return "", false
	}
	return line, true
}

// StagePaths are the files one stage attempt reads and writes in the sandbox.
type StagePaths struct {
	// Dir holds everything belonging to this attempt.
	Dir string
	// Prompt is the rendered stage prompt, written before the stage starts.
	// Passing it as a file rather than an argument is what keeps issue text out
	// of argv.
	Prompt string
	// Schema constrains the stage's final message.
	Schema string
	// Result is the schema-conforming final message. Its existence is the
	// stage's completion record: present means done, and the stage must be read
	// from it rather than re-run.
	Result string
	// PID holds the process ID of a running attempt. Present with a live
	// process means attach and wait; present with a dead one means the attempt
	// died and must be redone.
	PID string
}

// Paths returns where this attempt's files live inside the sandbox.
func (k StageKey) Paths() StagePaths {
	dir := path.Join(SandboxRoot, k.RunID, string(k.Stage))
	return StagePaths{
		Dir:    dir,
		Prompt: path.Join(dir, "prompt.md"),
		Schema: path.Join(dir, "schema.json"),
		Result: path.Join(dir, "result.json"),
		PID:    path.Join(dir, "codex.pid"),
	}
}

// TranscriptPath is where this attempt's raw event stream is stored, relative
// to the transcript volume's root.
//
// The volume is mounted on the worker, never on the sandbox: the worker pulls
// the stream out, so a sandbox holds nothing worth keeping and reaches nothing
// worth stealing. Keyed by RunID so a retry stays separately inspectable from
// the attempt it replaced.
func (k StageKey) TranscriptPath() string {
	return path.Join(fmt.Sprintf("%d", k.Ticket), k.RunID, string(k.Stage)+".jsonl")
}
