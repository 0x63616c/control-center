package work

import "fmt"

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

	// RunID identifies the latest execution. When Open it lets a dispatcher
	// adopt the run that owns the ticket; when closed it names the execution
	// that consumed the ticket's workflow ID. It is empty only when Temporal
	// reports that the workflow has never existed.
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

	// CPURequest and MemoryLimit are Kubernetes quantity strings ("2", "8Gi").
	CPURequest  string
	MemoryLimit string

	// DeadlineSeconds is the pod's hard ceiling. It must sit above the
	// workflow's own timeout so Kubernetes never kills a pod Temporal still
	// believes in — the inequality is asserted where both numbers are known,
	// not here, because this struct only holds one of them.
	DeadlineSeconds int64

	// Env is the sandbox's non-secret runtime configuration: its private
	// Temporal queue plus the Temporal and blob endpoints used by typed tools.
	// Provider credentials remain on the main worker.
	Env map[string]string
}

// Validate reports why this template cannot build a pod.
//
// Every field is required. An unset image would be an obscure ImagePullBackOff
// on the first ticket, and an unset memory limit would put an unbounded pod on
// the box that runs the house — both worth refusing at construction instead.
func (t SandboxTemplate) Validate() error {
	switch {
	case t.Image == "":
		return fmt.Errorf("%w: the sandbox needs an image", ErrInvalidRun)
	case t.CPURequest == "" || t.MemoryLimit == "":
		return fmt.Errorf("%w: the sandbox needs both a CPU request and a memory limit", ErrInvalidRun)
	case t.DeadlineSeconds <= 0:
		return fmt.Errorf("%w: the sandbox needs a deadline, or a wedged pod outlives the cluster", ErrInvalidRun)
	}
	return nil
}

// SpecForFactoryTicket returns the pod spec for one run's sandbox.
//
// The branch is derived here rather than passed in, so the name the sandbox
// pushes to and the name the worker later queries GitHub for come from one
// call. A caller that could supply its own would be a caller that could supply
// a different one — the drift that produced #603, where a run pushed to one
// branch while its workflow asked GitHub to open a pull request against
// another and GitHub rejected the head ref as unresolvable (422 Field:head
// Code:invalid). SandboxTaskQueue is derived the same way and for the same
// reason (#434, D1/D2): the queue this run's pod polls and the queue
// workflow.CreateSession names must be the exact same computation, not two
// call sites that happen to agree today.
func (t SandboxTemplate) SpecForFactoryTicket(ticketID int64, runID string) SandboxSpec {
	ticketNumber := int(ticketID)
	branch := FactoryTicketBranchName(ticketID, runID)
	env := make(map[string]string, len(t.Env)+2)
	for k, v := range t.Env {
		env[k] = v
	}
	env[SandboxBranchEnv] = branch
	env[SandboxTaskQueueEnv] = SandboxTaskQueue(runID)
	return SandboxSpec{
		TicketNumber:    ticketNumber,
		RunID:           runID,
		Image:           t.Image,
		CPURequest:      t.CPURequest,
		MemoryLimit:     t.MemoryLimit,
		DeadlineSeconds: t.DeadlineSeconds,
		Env:             env,
	}
}
