package main

import (
	"context"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/temporal"
)

// dispatcherStarter is the one method this needs off temporal.Client, named the
// way internal/clients/runs narrows DescribeWorkflowExecution: a test can
// fake it without a Temporal connection.
//
// Why boot rather than a Temporal Schedule: the dispatcher is a long-running
// timer loop holding its concurrency state (InFlight) in workflow state across
// ContinueAsNew, not a stateless thing a Schedule re-invokes. A Schedule
// creates a fresh execution each time it fires, which would restart that state
// from nothing on every tick — the opposite of what makes the concurrency cap
// durable. Start-if-absent on boot is the shape that matches a singleton whose
// state must survive the worker that started it.
type dispatcherStarter interface {
	ExecuteWorkflow(ctx context.Context, options temporal.StartWorkflowOptions, workflow interface{}, args ...interface{}) (temporal.WorkflowRun, error)
}
