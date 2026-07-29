package work

import "fmt"

// StatusReport is everything a run's status comment says about itself at one
// moment.
//
// It is data rather than prose so the thing that renders it and the thing that
// posts it are different modules, and so a workflow can decide *what* to report
// without knowing how a comment is worded. Rendering is not a workflow's job:
// prose changes far more often than orchestration, and a wording change must
// not be a workflow change.
//
// The ticket appears as a number and nothing else. Title and body are
// attacker-controllable, and a status comment is posted *on* the issue that
// carries them, so repeating them buys nothing and would put chosen text on a
// path that does not need it.
type StatusReport struct {
	TicketNumber int

	// RunID is Temporal's RunID, which is both the link to the run and what
	// makes the comment's marker this run's. See StatusMarker.
	RunID string

	// Stage is the stage now running, and empty when the run is starting or
	// over.
	Stage Stage

	// Outcome is empty while the run is still going.
	Outcome Outcome

	// Usage is the run's total so far, so cost is visible where the work is
	// reviewed rather than only in a dashboard.
	Usage Usage

	// Detail is free text — a failure's reason, or what the run is waiting on.
	// Nothing branches on it.
	Detail string

	// Comment is the comment to edit, and zero means none exists yet. It is the
	// whole of "post once, edit in place": a run that has posted carries the ID
	// forward, and a run that has not cannot accidentally edit another's.
	Comment CommentID
}

// RunState is what a lookup of a ticket's workflow found.
//
// It exists so the dispatcher's reconcile speaks domain vocabulary rather than
// Temporal's: the question is "does this ticket still have a run working it",
// and the answer that matters is a bool plus which run, not an execution status
// enum with a dozen members.
type RunState struct {
	// Open reports whether a run is still going. A workflow that has never
	// existed and one that has closed are the same answer to the dispatcher —
	// the slot is free — so they are not distinguished here.
	Open bool

	// RunID identifies the open run, so a dispatcher that has forgotten a
	// ticket can adopt the run that owns it rather than starting a second one.
	// Empty when Open is false.
	RunID string
}

// SandboxTemplate is the part of a sandbox's shape that is the same for every
// ticket: the image it runs, what it may consume, and how long Kubernetes will
// tolerate it.
//
// It is worker config rather than run policy, which is why it is not in
// RunPolicy and not on the UpdateConfig signal. Nothing a human tunes at
// runtime lives here, and a change to it is a deploy.
type SandboxTemplate struct {
	Image string

	// CPULimit and MemoryLimit are Kubernetes quantity strings ("2", "4Gi").
	CPULimit    string
	MemoryLimit string

	// DeadlineSeconds is the pod's hard ceiling. It must sit above the
	// workflow's own timeout so Kubernetes never kills a pod Temporal still
	// believes in — the inequality is asserted where both numbers are known,
	// not here, because this struct only holds one of them.
	DeadlineSeconds int64

	// Env is the sandbox's environment: the ephemeral CODEX_HOME and nothing
	// secret. Credentials are written as files, by the activity that fetches
	// them, inside the pod.
	Env map[string]string
}

// Validate reports why this template cannot build a pod.
//
// Every field is required. An unset image would be an obscure ImagePullBackOff
// on the first ticket, and an unset limit would put an unbounded pod on the box
// that runs the house — both worth refusing at construction instead.
func (t SandboxTemplate) Validate() error {
	switch {
	case t.Image == "":
		return fmt.Errorf("%w: the sandbox needs an image", ErrInvalidRun)
	case t.CPULimit == "" || t.MemoryLimit == "":
		return fmt.Errorf("%w: the sandbox needs both a CPU and a memory limit", ErrInvalidRun)
	case t.DeadlineSeconds <= 0:
		return fmt.Errorf("%w: the sandbox needs a deadline, or a wedged pod outlives the cluster", ErrInvalidRun)
	}
	return nil
}

// Spec returns the pod spec for one run's sandbox.
//
// The branch is derived here rather than passed in, so the name the sandbox
// pushes to and the name the worker later queries GitHub for come from one
// call. A caller that could supply its own would be a caller that could supply
// a different one.
func (t SandboxTemplate) Spec(ticketNumber int, runID string) SandboxSpec {
	env := make(map[string]string, len(t.Env)+1)
	for k, v := range t.Env {
		env[k] = v
	}
	env[SandboxBranchEnv] = BranchName(ticketNumber, runID)
	return SandboxSpec{
		TicketNumber:    ticketNumber,
		RunID:           runID,
		Image:           t.Image,
		CPULimit:        t.CPULimit,
		MemoryLimit:     t.MemoryLimit,
		DeadlineSeconds: t.DeadlineSeconds,
		Env:             env,
	}
}
