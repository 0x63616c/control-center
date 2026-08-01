package cutover

import (
	"context"
	"fmt"
	"time"

	githubclient "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/github"
	k8sclient "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/k8s"
	temporalclient "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/temporal"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
)

// LiveDependencies adapts the already-deployed worker credentials to the
// deliberately small cutover interfaces.
func LiveDependencies(temporal temporalclient.Client, namespace string, sandboxes *k8sclient.Sandboxes, github *githubclient.Client, tickets *store.Store, clk clock.Clock) Dependencies {
	return Dependencies{
		Temporal:  &liveTemporal{controller: temporalclient.NewLegacyController(temporal, namespace, clk)},
		Sandboxes: liveSandboxes{client: sandboxes},
		GitHub:    liveGitHub{client: github},
		Tickets:   liveTickets{store: tickets, clock: clk},
	}
}

type liveSandboxes struct{ client *k8sclient.Sandboxes }

func (live liveSandboxes) ListLegacySandboxes(ctx context.Context) ([]LegacySandbox, error) {
	listed, err := live.client.ListLegacySandboxes(ctx)
	if err != nil {
		return nil, fmt.Errorf("listing legacy Kubernetes sandboxes: %w", err)
	}
	result := make([]LegacySandbox, 0, len(listed))
	for _, sandbox := range listed {
		result = append(result, LegacySandbox{Name: sandbox.Name, UID: sandbox.UID, RunID: sandbox.RunID, Ticket: sandbox.Ticket})
	}
	return result, nil
}

func (live liveSandboxes) DeleteLegacySandbox(ctx context.Context, sandbox LegacySandbox) error {
	return live.client.DeleteLegacySandbox(ctx, k8sclient.LegacySandbox{Name: sandbox.Name, UID: sandbox.UID, RunID: sandbox.RunID, Ticket: sandbox.Ticket})
}

type liveTemporal struct {
	controller *temporalclient.LegacyController
}

func (live *liveTemporal) ListLegacyExecutions(ctx context.Context) ([]WorkflowExecution, error) {
	listed, err := live.controller.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("listing legacy Temporal executions: %w", err)
	}
	result := make([]WorkflowExecution, 0, len(listed))
	for _, execution := range listed {
		kind := WorkflowTicket
		switch execution.Kind {
		case temporalclient.LegacyDispatcher:
			kind = WorkflowDispatcher
		case temporalclient.LegacyAgent:
			kind = WorkflowAgent
		}
		result = append(result, WorkflowExecution{ID: execution.ID, RunID: execution.RunID, Kind: kind, Type: execution.Type, Status: execution.Status})
	}
	return result, nil
}

func (live *liveTemporal) PauseLegacyDispatcher(ctx context.Context) error {
	return live.controller.PauseDispatcher(ctx)
}

func (live *liveTemporal) CancelLegacyExecution(ctx context.Context, execution WorkflowExecution) error {
	return live.controller.Cancel(ctx, temporalExecution(execution))
}

func (live *liveTemporal) AwaitLegacyExecutionClosed(ctx context.Context, execution WorkflowExecution, grace time.Duration) (bool, error) {
	return live.controller.AwaitClosed(ctx, temporalExecution(execution), grace)
}

func (live *liveTemporal) TerminateLegacyExecution(ctx context.Context, execution WorkflowExecution) error {
	return live.terminate(ctx, execution)
}

func (live *liveTemporal) TerminateLegacyDispatcher(ctx context.Context, execution WorkflowExecution) error {
	return live.terminate(ctx, execution)
}

func (live *liveTemporal) terminate(ctx context.Context, execution WorkflowExecution) error {
	return live.controller.Terminate(ctx, temporalExecution(execution))
}

func temporalExecution(execution WorkflowExecution) temporalclient.LegacyExecution {
	kind := temporalclient.LegacyTicket
	switch execution.Kind {
	case WorkflowDispatcher:
		kind = temporalclient.LegacyDispatcher
	case WorkflowAgent:
		kind = temporalclient.LegacyAgent
	}
	return temporalclient.LegacyExecution{ID: execution.ID, RunID: execution.RunID, Kind: kind, Type: execution.Type, Status: execution.Status}
}

type liveGitHub struct{ client *githubclient.Client }

func (live liveGitHub) ListLegacyPullRequests(ctx context.Context) ([]PullRequest, error) {
	listed, err := live.client.LegacyPullRequests(ctx)
	if err != nil {
		return nil, fmt.Errorf("listing legacy pull requests: %w", err)
	}
	result := make([]PullRequest, 0, len(listed))
	for _, pr := range listed {
		result = append(result, PullRequest{
			Number: pr.Number, NodeID: pr.NodeID, Branch: pr.Branch, URL: pr.URL, AutoMergeEnabled: pr.AutoMergeEnabled,
		})
	}
	return result, nil
}

func (live liveGitHub) DisableAutoMerge(ctx context.Context, pullRequest PullRequest) error {
	if err := live.client.DisablePullRequestAutoMerge(ctx, pullRequest.NodeID); err != nil {
		return fmt.Errorf("disabling auto-merge on pull request %d: %w", pullRequest.Number, err)
	}
	return nil
}

type liveTickets struct {
	store *store.Store
	clock clock.Clock
}

func (live liveTickets) ListLegacyTickets(ctx context.Context) ([]LegacyTicket, error) {
	working, err := live.store.TicketsByState(ctx, store.TicketWorking)
	if err != nil {
		return nil, fmt.Errorf("listing legacy working tickets: %w", err)
	}
	review, err := live.store.TicketsByState(ctx, store.TicketReview)
	if err != nil {
		return nil, fmt.Errorf("listing legacy review tickets: %w", err)
	}
	result := make([]LegacyTicket, 0, len(working)+len(review))
	for _, ticket := range append(working, review...) {
		converted, err := legacyTicket(ticket)
		if err != nil {
			return nil, err
		}
		result = append(result, converted)
	}
	return result, nil
}

func (live liveTickets) ListLegacyRuns(ctx context.Context) ([]LegacyRun, error) {
	listed, err := live.store.OpenLegacyRuns(ctx)
	if err != nil {
		return nil, fmt.Errorf("listing open legacy database runs: %w", err)
	}
	runs := make([]LegacyRun, 0, len(listed))
	for _, run := range listed {
		runs = append(runs, LegacyRun{ID: run.ID, TicketID: int64(run.TicketID), StartedAt: run.StartedAt.UTC()})
	}
	return runs, nil
}

func (live liveTickets) ReconcileLegacyState(ctx context.Context, expected []LegacyTicket, expectedRuns []LegacyRun) ([]LegacyTicket, error) {
	snapshots := make([]store.Ticket, 0, len(expected))
	for _, ticket := range expected {
		state, err := storeTicketState(ticket.State)
		if err != nil {
			return nil, fmt.Errorf("mapping legacy ticket %d state: %w", ticket.ID, err)
		}
		snapshots = append(snapshots, store.Ticket{ID: store.TicketID(ticket.ID), State: state, UpdatedAt: ticket.Version})
	}
	runSnapshots := make([]store.Run, 0, len(expectedRuns))
	for _, run := range expectedRuns {
		runSnapshots = append(runSnapshots, store.Run{ID: run.ID, TicketID: store.TicketID(run.TicketID), StartedAt: run.StartedAt})
	}
	reopened, err := live.store.ReconcileLegacyState(ctx, snapshots, runSnapshots, live.clock.Now())
	if err != nil {
		return nil, fmt.Errorf("reconciling legacy runs and tickets transactionally: %w", err)
	}
	result := make([]LegacyTicket, 0, len(reopened))
	for _, ticket := range reopened {
		converted, err := legacyTicket(ticket)
		if err != nil {
			return nil, err
		}
		result = append(result, converted)
	}
	return result, nil
}

func legacyTicket(ticket store.Ticket) (LegacyTicket, error) {
	state, err := legacyTicketState(ticket.State)
	if err != nil {
		return LegacyTicket{}, fmt.Errorf("mapping ticket %d from the store: %w", ticket.ID, err)
	}
	return LegacyTicket{ID: int64(ticket.ID), State: state, Version: ticket.UpdatedAt.UTC()}, nil
}

func legacyTicketState(state store.TicketState) (LegacyTicketState, error) {
	switch state {
	case store.TicketOpen:
		return LegacyTicketOpen, nil
	case store.TicketWorking:
		return LegacyTicketWorking, nil
	case store.TicketReview:
		return LegacyTicketReview, nil
	default:
		return "", fmt.Errorf("unsupported legacy ticket state %q", state)
	}
}

func storeTicketState(state LegacyTicketState) (store.TicketState, error) {
	switch state {
	case LegacyTicketOpen:
		return store.TicketOpen, nil
	case LegacyTicketWorking:
		return store.TicketWorking, nil
	case LegacyTicketReview:
		return store.TicketReview, nil
	default:
		return store.TicketState{}, fmt.Errorf("unsupported legacy ticket state %q", state)
	}
}
