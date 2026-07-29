package main

import (
	"context"
	"fmt"
	"log/slog"

	"go.temporal.io/sdk/client"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
)

// dispatcherStarter is the one method this needs off client.Client, named the
// way internal/clients/runs narrows DescribeWorkflowExecution: a test can
// fake it without a Temporal connection.
type dispatcherStarter interface {
	ExecuteWorkflow(ctx context.Context, options client.StartWorkflowOptions, workflow interface{}, args ...interface{}) (client.WorkflowRun, error)
}

// ensureDispatcher starts the one dispatcher workflow, or attaches to it if a
// worker before this one already did.
//
// It is a plain Client.ExecuteWorkflow on work.DispatcherWorkflowID, and that
// alone is what makes it idempotent: Client.ExecuteWorkflow's
// WorkflowExecutionErrorWhenAlreadyStarted defaults to false, so calling this
// against a workflow ID that is already running does not error — it returns a
// WorkflowRun for the execution that is already there. Every worker replica
// calls this on its own boot, and at most one of them actually starts
// anything; the rest attach.
//
// Why boot rather than a Temporal Schedule: dispatcher.go's own doc comment
// says the dispatcher is a long-running timer loop holding its concurrency
// state (InFlight, the breaker) in workflow state across ContinueAsNew, not a
// stateless thing a Schedule re-invokes. A Schedule creates a fresh execution
// each time it fires, which would restart that state from nothing on every
// tick — the opposite of what makes the concurrency cap durable. Start-if-
// absent on boot is the shape that matches a singleton whose state must
// survive the worker that started it.
//
// dispatcherConfig is only used if this call is the one that actually starts
// the workflow. An attach to an already-running dispatcher does not apply it
// — see LoadDispatcher's doc comment: DISPATCHER_CONFIG is read at the
// dispatcher's first-ever start and carried in workflow state after that, so
// a later boot's value is read, logged (see "dispatcher_starting_config"
// above) and then genuinely ignored by Temporal, not by this function.
func ensureDispatcher(ctx context.Context, c dispatcherStarter, dispatcherConfig work.Config, logger *slog.Logger) error {
	run, err := c.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
		ID:        work.DispatcherWorkflowID,
		TaskQueue: work.TaskQueue,
	}, workflows.Dispatcher, workflows.DispatcherInput{
		Config: dispatcherConfig,
		Tuning: work.DefaultDispatcherTuning(),
		Run:    work.DefaultRunPolicy(),
	})
	if err != nil {
		return fmt.Errorf("starting the dispatcher workflow %s: %w", work.DispatcherWorkflowID, err)
	}

	logger.Info("dispatcher workflow ensured",
		slog.String("workflow_id", work.DispatcherWorkflowID),
		slog.String("run_id", run.GetRunID()))
	return nil
}
