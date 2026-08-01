package cutover

import (
	"context"
	"errors"
	"fmt"
	"time"

	githubclient "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/github"
	temporalclient "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/temporal"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	workflowservice "go.temporal.io/api/workflowservice/v1"
)

const (
	legacyDispatcherType = "FactoryDispatcher"
	legacyTicketType     = "FactoryWorkTicket"
	terminationReason    = "software-factory v0 cutover"
)

// LiveDependencies adapts the already-deployed worker credentials to the
// deliberately small cutover interfaces.
func LiveDependencies(temporal temporalclient.Client, namespace string, github *githubclient.Client, tickets *store.Store, clk clock.Clock) Dependencies {
	return Dependencies{
		Temporal: &liveTemporal{client: temporal, namespace: namespace, clock: clk},
		GitHub:   liveGitHub{client: github},
		Tickets:  liveTickets{store: tickets},
	}
}

type liveTemporal struct {
	client    temporalclient.Client
	namespace string
	clock     clock.Clock
}

func (live *liveTemporal) ListLegacyExecutions(ctx context.Context) ([]WorkflowExecution, error) {
	request := &workflowservice.ListWorkflowExecutionsRequest{
		Namespace: live.namespace,
		PageSize:  100,
		Query:     `ExecutionStatus = 'Running' AND (WorkflowType = 'FactoryDispatcher' OR WorkflowType = 'FactoryWorkTicket')`,
	}
	var result []WorkflowExecution
	for {
		response, err := live.client.ListWorkflow(ctx, request)
		if err != nil {
			return nil, err
		}
		for _, execution := range response.Executions {
			kind := WorkflowTicket
			if execution.GetType().GetName() == legacyDispatcherType {
				kind = WorkflowDispatcher
			}
			result = append(result, WorkflowExecution{
				ID: execution.GetExecution().GetWorkflowId(), RunID: execution.GetExecution().GetRunId(),
				Kind: kind, Type: execution.GetType().GetName(), Status: execution.GetStatus().String(),
			})
		}
		if len(response.NextPageToken) == 0 {
			break
		}
		request.NextPageToken = response.NextPageToken
	}
	return nonNil(result), nil
}

func (live *liveTemporal) PauseLegacyDispatcher(ctx context.Context) error {
	paused := true
	reason := terminationReason
	return live.client.SignalWorkflow(ctx, work.FactoryDispatcherWorkflowID, "", workflows.SignalUpdateConfig, work.ConfigUpdate{
		Paused: &paused, PauseReason: &reason,
	})
}

func (live *liveTemporal) CancelLegacyExecution(ctx context.Context, execution WorkflowExecution) error {
	err := live.client.CancelWorkflow(ctx, execution.ID, execution.RunID)
	if isNotFound(err) {
		return nil
	}
	return err
}

func (live *liveTemporal) AwaitLegacyExecutionClosed(ctx context.Context, execution WorkflowExecution, grace time.Duration) (bool, error) {
	deadline := live.clock.Now().Add(grace)
	for {
		description, err := live.client.DescribeWorkflowExecution(ctx, execution.ID, execution.RunID)
		if isNotFound(err) {
			return true, nil
		}
		if err != nil {
			return false, err
		}
		if description.GetWorkflowExecutionInfo().GetStatus() != enumspb.WORKFLOW_EXECUTION_STATUS_RUNNING {
			return true, nil
		}
		remaining := deadline.Sub(live.clock.Now())
		if remaining <= 0 {
			return false, nil
		}
		if err := live.clock.Sleep(ctx, min(remaining, time.Second)); err != nil {
			return false, err
		}
	}
}

func (live *liveTemporal) TerminateLegacyExecution(ctx context.Context, execution WorkflowExecution) error {
	return live.terminate(ctx, execution)
}

func (live *liveTemporal) TerminateLegacyDispatcher(ctx context.Context, execution WorkflowExecution) error {
	return live.terminate(ctx, execution)
}

func (live *liveTemporal) terminate(ctx context.Context, execution WorkflowExecution) error {
	err := live.client.TerminateWorkflow(ctx, execution.ID, execution.RunID, terminationReason)
	if isNotFound(err) {
		return nil
	}
	return err
}

func isNotFound(err error) bool {
	var notFound *serviceerror.NotFound
	return errors.As(err, &notFound)
}

type liveGitHub struct{ client *githubclient.Client }

func (live liveGitHub) ListLegacyPullRequests(ctx context.Context) ([]PullRequest, error) {
	listed, err := live.client.LegacyPullRequests(ctx)
	if err != nil {
		return nil, err
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
	return live.client.DisablePullRequestAutoMerge(ctx, pullRequest.NodeID)
}

type liveTickets struct{ store *store.Store }

func (live liveTickets) ListLegacyTickets(ctx context.Context) ([]LegacyTicket, error) {
	working, err := live.store.TicketsByState(ctx, store.TicketWorking)
	if err != nil {
		return nil, err
	}
	review, err := live.store.TicketsByState(ctx, store.TicketReview)
	if err != nil {
		return nil, err
	}
	result := make([]LegacyTicket, 0, len(working)+len(review))
	for _, ticket := range append(working, review...) {
		result = append(result, legacyTicket(ticket))
	}
	return result, nil
}

func (live liveTickets) ReopenLegacyTickets(ctx context.Context, expected []LegacyTicket) ([]LegacyTicket, error) {
	snapshots := make([]store.Ticket, 0, len(expected))
	for _, ticket := range expected {
		state, err := store.ParseTicketState(ticket.State)
		if err != nil {
			return nil, fmt.Errorf("parsing legacy ticket %d state: %w", ticket.ID, err)
		}
		version, err := time.Parse(time.RFC3339Nano, ticket.Version)
		if err != nil {
			return nil, fmt.Errorf("parsing legacy ticket %d version: %w", ticket.ID, err)
		}
		snapshots = append(snapshots, store.Ticket{ID: store.TicketID(ticket.ID), State: state, UpdatedAt: version})
	}
	reopened, err := live.store.ReopenLegacyTickets(ctx, snapshots)
	if err != nil {
		return nil, err
	}
	result := make([]LegacyTicket, 0, len(reopened))
	for _, ticket := range reopened {
		result = append(result, legacyTicket(ticket))
	}
	return result, nil
}

func legacyTicket(ticket store.Ticket) LegacyTicket {
	return LegacyTicket{ID: int64(ticket.ID), State: ticket.State.String(), Version: ticket.UpdatedAt.UTC().Format(time.RFC3339Nano)}
}
