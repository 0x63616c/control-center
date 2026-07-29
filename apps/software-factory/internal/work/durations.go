package work

import "time"

// The deadlines a run is bounded by, in one place because they are one ladder.
//
// Four different systems enforce these — Temporal enforces the activity and run
// timeouts, Kubernetes enforces the pod's, and codexauth sizes a credential's
// refresh margin against the stage — and each of them holds only its own end.
// Written where each is used, the ladder would be four numbers that have to
// agree and nothing that notices when they stop. The inequalities between them
// are tested in durations_test.go and durations_inv3_test.go; a value tuned
// without re-deriving the rest fails there rather than in production.
//
// Nothing here is configurable. These are the deadlines the system is designed
// around, not knobs: an operator wanting a longer stage is asking for a
// different credential margin and a different pod deadline too, which is a
// change to this file and a deploy, not an environment variable.
const (
	// MaxStageDuration is the longest one stage may run, and the
	// StartToCloseTimeout of the activity that runs it.
	//
	// ADR-0011 sets it at 60 minutes, "deliberately generous until real timings
	// exist". It is also an input to INV-3 in codexauth: a sandbox holds a
	// credential copy it cannot refresh, so the refresh margin has to outlast a
	// whole stage. codexauth takes it positionally, with no default, precisely
	// so this constant is the only place it is written.
	MaxStageDuration = 60 * time.Minute

	// StageHeartbeatTimeout is how long a stage may emit nothing before it is
	// treated as dead rather than slow.
	//
	// ADR-0011: "Activities heartbeat at 1 minute — that is what makes a
	// 60-minute activity cancellable rather than a black box." The heartbeat is
	// driven by the stage's own event stream, so this is also an assertion
	// about codex: a model turn that emits no event for a minute would be
	// killed as dead. That is the number to revisit first if real runs show
	// long silent turns.
	StageHeartbeatTimeout = time.Minute

	// MaxRunDuration is the workflow run timeout for one ticket: above the sum
	// of its five stages, with room for the cheap activities between them —
	// labels, status comments, the sandbox's own lifecycle.
	MaxRunDuration = 6 * time.Hour

	// SandboxDeadline is the pod's activeDeadlineSeconds, above the run
	// timeout so Kubernetes never kills a sandbox a live run still expects.
	// A stage whose pod vanished under it reports an exec failure with no
	// cause, which is the most expensive kind of failure to diagnose.
	SandboxDeadline = 7 * time.Hour

	// SandboxDeadlineSeconds is that deadline in the units Kubernetes takes,
	// converted here rather than at the call site so the units cannot be got
	// wrong twice.
	SandboxDeadlineSeconds = int64(SandboxDeadline / time.Second)
)
