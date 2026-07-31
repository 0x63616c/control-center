package work

// TaskQueue is the Temporal task queue this service's workflows and activities
// are scheduled on, and the only place its name is written.
//
// It is here because the name is PUBLISHED. An operator types it into
// `temporal task-queue describe`, the first-run runbook names it, and the
// composition root needs it in Go to register a worker that polls it. A name
// that leaves the process has one home; that is the whole reason, and it does
// not need a second consumer inside the codebase to earn it.
//
// It is deliberately NOT read by workflow code. Temporal schedules a child
// workflow or an activity onto the queue its parent workflow is already on
// unless told otherwise — verified against go.temporal.io/sdk v1.47.0's source
// rather than its documentation. Starting a workflow seeds the context with the
// workflow's own queue (internal/internal_workflow.go:505 for children, :509
// for activities), and the option setters overwrite it only when the caller
// passes a non-empty value (internal/workflow.go:2052-2054 and :2710-2712). The
// field docs say the same (internal/workflow.go:462, internal/activity.go:109).
//
// That is why the option builders in internal/workflows omit TaskQueue, and why
// naming it there would be a mistake rather than a belt-and-braces: it turns one
// written name into five, which is the precondition for the divergence a single
// home exists to prevent.
//
// It is a constant rather than configuration for a related reason. A queue name
// settable per environment would let the worker and whatever schedules onto it
// disagree at runtime, and that failure is silent at both ends — a worker
// polling a queue nobody sends to looks exactly like a system with nothing to
// do. Pointing a worker at an experimental queue is a change to this line and a
// deploy: deliberate, reviewable, and impossible to do to one side only.
//
// One string, two concepts: the Temporal NAMESPACE is also "software-factory"
// (infra/src/temporal.ts). They are passed on the same command lines, so a
// transposed --namespace and --task-queue is invisible.
//
// The same fact by the same rule as WorkflowID in paths.go: one name, one home,
// nothing else may construct it.
const TaskQueue = "software-factory"

// sandboxTaskQueuePrefix opens every per-ticket sandbox queue name, so the two
// families of queue are visually distinct in `temporal task-queue describe`
// and in Temporal history, and so a literal "software-factory-sandbox-" typed
// anywhere else would be a second spelling rather than a second home.
const sandboxTaskQueuePrefix = "software-factory-sandbox-"

// SandboxTaskQueue is the per-ticket task queue one sandbox pod's embedded
// worker polls.
//
// It is a function of the run, not a constant, per D1 (#434's addendum):
// step 3 ships no warm pool, so pods are per-ticket, and a pod that only ever
// serves one run has no reason to share a queue with any other pod. A shared
// queue is the right shape for a *pool*, where CreateSession must be free to
// hand a ticket to whichever idle member picks up the poll — with one pod per
// ticket that indirection buys nothing and only risks a session landing on a
// stranger's pod if the shared queue is ever reused across runs.
//
// runID is Temporal's RunID for the enclosing WorkTicket execution — the same
// value StageKey.RunID and SandboxSpec.RunID already carry, so this needs no
// identity of its own (see "Identity" in docs/SoftwareStyle.md: do not mint
// IDs Temporal already gives). Deriving the queue from it means the workflow,
// the pod's own env var and the composition root that registers the worker
// all agree without a second value ever being passed around.
func SandboxTaskQueue(runID string) string {
	return sandboxTaskQueuePrefix + runID
}

// SandboxTaskQueueEnv is the environment variable a sandbox pod's embedded
// worker reads its own SandboxTaskQueue value back from.
//
// It is part of the contract with the sandbox image, the same shape as
// SandboxBranchEnv and CodexHomeEnv: whoever builds the pod's env
// (CreateSandbox, via SandboxTemplate.Spec) computes SandboxTaskQueue(runID)
// once and sets it here, and cmd/sandbox-worker reads it back rather than
// recomputing it — the same "read back what CreateSandbox baked in" pattern
// CloneRepo already uses for SF_BRANCH, so the two can never disagree about
// which queue this pod is supposed to be polling.
//
// Set on every sandbox pod's spec by SandboxTemplate.Spec (status.go), the
// same place SandboxBranchEnv is computed per ticket — both are per-run
// values a static template cannot hold in advance, so both are added there
// rather than in the template's own Env map.
const SandboxTaskQueueEnv = "SANDBOX_TASK_QUEUE"

// SandboxTemporalHostPortEnv, SandboxTemporalNamespaceEnv and SandboxBlobsURLEnv are the
// environment variables a sandbox pod's embedded worker dials Temporal with.
//
// Unlike SandboxTaskQueueEnv these are NOT per-ticket: every sandbox pod in
// this cluster reaches the same Temporal frontend the main worker itself
// dials, so the composition root (cmd/worker/main.go) sets both once, from
// the exact same config.Worker fields it uses to dial Temporal for itself,
// into SandboxTemplate's own static Env map — not computed per ticket the
// way SandboxTaskQueueEnv is.
//
// The names match config.SandboxWorker's own (and the main worker's
// TEMPORAL_HOST_PORT/TEMPORAL_NAMESPACE), deliberately: an operator who
// already knows those two names from the main worker's Deployment does not
// need a third pair to look up for the sandbox.
const (
	SandboxTemporalHostPortEnv  = "TEMPORAL_HOST_PORT"
	SandboxTemporalNamespaceEnv = "TEMPORAL_NAMESPACE"
	SandboxBlobsURLEnv          = "BLOBS_URL"
)
