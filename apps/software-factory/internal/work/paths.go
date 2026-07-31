package work

import (
	"fmt"
	"path"
	"strconv"
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

// CodexHomeDir is the ephemeral CODEX_HOME inside the sandbox: where the codex
// CLI reads its auth.json from, and the only place a sandbox's codex
// credential is ever written.
//
// It is a sibling of RepoDir under SandboxRoot, for the reason RepoDir gives
// for the git credential file: RepoDir becomes the run's git working tree the
// moment it is cloned, and a credential file living inside one is one
// `git add -A` away from being committed into the branch the run pushes.
const CodexHomeDir = SandboxRoot + "/.codex"

// CodexHomeEnv is the environment variable that tells the codex CLI where to
// find CodexHomeDir. Like SandboxBranchEnv, it is part of the contract with
// the sandbox image — the composition root sets it on every sandbox's
// template, and this is the one place that names it.
const CodexHomeEnv = "CODEX_HOME"

// CodexAuthFile is where the codex CLI's auth.json lives inside CodexHomeDir —
// the file codex exec reads on every invocation to authenticate. It is a
// symlink to CodexAuthSecretMountFile, created by cmd/sandbox-worker at
// startup — see that constant's own doc comment for why it is not the Secret
// mount itself.
const CodexAuthFile = CodexHomeDir + "/auth.json"

// CodexAuthSecretMountFile is where the sandbox's per-ticket credential
// Secret is actually mounted by Kubernetes — deliberately NOT inside
// CodexHomeDir, and outside SandboxRoot entirely.
//
// A subPath volume mount forces Kubernetes to create any directory that has
// to host it, as root, before the container's own process ever starts — the
// same trap RepoDir's own doc comment describes for a WORKDIR the container
// runtime has to create inside an emptyDir. Mounting the credential Secret
// directly under CodexHomeDir (D3, #434) made THAT directory root-owned
// instead of owned by the sandbox uid, and codex needs to write other files
// there too — a PATH-aliases file, its app-server socket — not just read
// auth.json out of it. Every one of those writes failed with EACCES in prod
// run one: "WARNING: proceeding, even though we could not create PATH
// aliases: Permission denied (os error 13)", then "Error: failed to
// initialize in-process app-server client: Permission denied (os error 13)".
//
// Mounted here instead, cmd/sandbox-worker creates CodexHomeDir itself at
// startup — an ordinary os.MkdirAll, owned by the uid that made it, like
// every other directory this process creates under SandboxRoot — and
// symlinks CodexAuthFile to this path. The credential's bytes are still
// placed entirely by Kubernetes and never pass through a write this process
// performs; only CodexHomeDir's own ownership changes.
const CodexAuthSecretMountFile = "/var/run/secrets/software-factory/codex-auth.json"

// GhConfigDir is the gh CLI's config directory inside the sandbox, and
// GhHostsFile the credential file it reads out of it.
//
// gh was put in the sandbox because the old `propose` stage opened the pull
// request with it (#414). The pipeline rewrite (#435) moves PR create/edit to
// workflow code against go-github, so whether the sandbox still needs gh (and
// this credential file) at all is worth re-examining — not resolved here,
// since nothing else about the sandbox's gh usage changed as part of that
// rewrite. It needs its own credential file because it has no code path that
// reads git's: git resolves a token through credential.helper and a
// git-credential-store file, and gh looks only at GH_TOKEN in the environment
// or at this file. The same installation token therefore reaches the sandbox
// twice, in two formats — see clone.go's writeGhCredentials for why the
// environment is the wrong one of the two.
//
// Sibling of RepoDir under SandboxRoot for the reason RepoDir gives: RepoDir is
// a git working tree, and a credential file inside one is one `git add -A` away
// from being pushed. NOT $HOME/.config/gh, which is gh's default and would make
// the image's HOME a silent second contract; GH_CONFIG_DIR names it explicitly,
// the way CodexHomeEnv does for codex.
const (
	GhConfigDir = SandboxRoot + "/.gh"

	// GhConfigDirEnv is the environment variable pointing gh at GhConfigDir. Set
	// on every sandbox's template by the composition root, beside CodexHomeEnv.
	GhConfigDirEnv = "GH_CONFIG_DIR"

	// GhHostsFile is the file gh reads a host's token from. The name is gh's,
	// not ours.
	GhHostsFile = GhConfigDir + "/hosts.yml"
)

// StageKey identifies one stage attempt, and is the whole of that identity.
//
// Every deterministic path a stage keys off is derived from these four fields
// and nothing else. That is what makes a stage idempotent under activity retry:
// a rescheduled activity computes the same paths, finds what the previous
// attempt left behind, and resumes instead of restarting.
//
// Turn exists because implement and review each loop under this step's
// pipeline rewrite: RunID and Stage alone collided across turns, which would
// let a Temporal-level retry of one turn's activity resume from a later turn's
// session.id, or a later turn's own StagePaths().Dir. It is 1-indexed — the
// first attempt of a stage in a run is turn 1 — because that is the number a
// status comment shows a human ("implement, turn 3 of 15"), and a stage that
// never loops (plan) simply always runs at turn 1.
//
// None of the four can carry attacker-controlled text — a ticket number and a
// turn are both integers, a Temporal RunID is a UUID, and a Stage is one of
// three constants — so the paths below cannot be steered by anything an issue
// author writes.
type StageKey struct {
	// Ticket is the GitHub issue number.
	Ticket int
	// RunID is Temporal's RunID for the enclosing workflow run. It scopes the
	// attempt so a retried or re-run ticket stays separately inspectable rather
	// than overwriting its own history.
	RunID string
	Stage Stage
	// Turn is which attempt of Stage this is within RunID, starting at 1.
	Turn int
}

// String names the attempt for logs and errors.
func (k StageKey) String() string {
	return fmt.Sprintf("ticket #%d stage %s turn %d run %s", k.Ticket, k.Stage, k.Turn, k.RunID)
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

// FactoryTicketWorkflowID is the Temporal claim for a factory-owned Ticket.
// Its prefix is deliberately disjoint from WorkflowID: a completed legacy
// issue run may be reused by Temporal, so sharing the old namespace would
// make two unrelated tickets share one history lineage.
func FactoryTicketWorkflowID(ticketID int64) string {
	return fmt.Sprintf("factory-ticket-%d", ticketID)
}

// FactoryTicketBranchName names a Ticket-backed run's branch. It cannot
// collide with BranchName, which reserves software-factory/ticket-* for
// GitHub issue runs.
func FactoryTicketBranchName(ticketID int64, runID string) string {
	return path.Join("software-factory", "factory-ticket-"+strconv.FormatInt(ticketID, 10), runID)
}

// factoryTicketBranchPrefix is FactoryTicketBranchName's own middle segment
// prefix, named once so the parser below cannot drift from the constructor it
// inverts.
const factoryTicketBranchPrefix = "factory-ticket-"

// ParseFactoryTicketBranchName recovers the TicketID FactoryTicketBranchName
// encoded into a branch name, or false if branch was not built by that
// function.
//
// branch is attacker-controllable — it arrives off a GitHub pull_request
// webhook payload, which anyone who can open a pull request against this repo
// controls. Parsing it this strictly (three slash-separated segments, an
// exact literal prefix, a decimal integer with no sign or leading zero) means
// a crafted branch name can only ever resolve to a genuine positive TicketID
// or fail closed; it can never be coerced into resolving to the wrong Ticket
// or into anything this package's callers would have to sanitise further.
func ParseFactoryTicketBranchName(branch string) (ticketID int64, ok bool) {
	parts := strings.Split(branch, "/")
	if len(parts) != 3 || parts[0] != "software-factory" || parts[2] == "" {
		return 0, false
	}
	digits, hasPrefix := strings.CutPrefix(parts[1], factoryTicketBranchPrefix)
	if !hasPrefix || digits == "" || (len(digits) > 1 && digits[0] == '0') {
		return 0, false
	}
	id, err := strconv.ParseInt(digits, 10, 64)
	if err != nil || id <= 0 {
		return 0, false
	}
	return id, true
}

// DispatcherWorkflowID is the one dispatcher's Temporal workflow ID.
//
// It is a constant rather than derived from anything, because there is
// exactly one dispatcher: the composition root starts a workflow with this ID
// on every boot, and Temporal's default StartWorkflowOptions — reused across
// an already-running execution rather than erroring on it — is what makes
// that idempotent. A second spelling anywhere would be a second dispatcher.
const DispatcherWorkflowID = "software-factory-dispatcher"

// FactoryDispatcherWorkflowID is the singleton Ticket-backed dispatcher.
// One spelling is one dispatcher; the legacy dispatcher remains separate.
const FactoryDispatcherWorkflowID = "software-factory-ticket-dispatcher"

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
	// Lock serialises attempts of this exact stage while they probe and run.
	// It stays beside Result so no process outside this sandbox needs it.
	Lock string
}

// Paths returns where this attempt's files live inside the sandbox.
func (k StageKey) Paths() StagePaths {
	dir := path.Join(SandboxRoot, k.RunID, string(k.Stage), strconv.Itoa(k.Turn))
	return StagePaths{
		Dir:    dir,
		Prompt: path.Join(dir, "prompt.md"),
		Schema: path.Join(dir, "schema.json"),
		Result: path.Join(dir, "result.json"),
		Lock:   path.Join(dir, "codex.lock"),
	}
}

// TranscriptPath is where this attempt's raw event stream is stored, relative
// to the transcript volume's root.
//
// The volume is mounted on the worker, never on the sandbox: the worker pulls
// the stream out, so a sandbox holds nothing worth keeping and reaches nothing
// worth stealing. Keyed by RunID and Turn so a retry, and a later turn of a
// looping stage, each stay separately inspectable from the attempt they
// replaced or followed.
func (k StageKey) TranscriptPath() string {
	return path.Join(fmt.Sprintf("%d", k.Ticket), k.RunID, fmt.Sprintf("%s.%d.jsonl", k.Stage, k.Turn))
}
