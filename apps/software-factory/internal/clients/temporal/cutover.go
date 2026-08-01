package temporal

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	workflowservice "go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/client"
)

const cutoverTerminationReason = "software-factory v0 cutover"

// LegacyExecutionKind classifies the two workflow types retained for cutover.
type LegacyExecutionKind string

const (
	// LegacyDispatcher is the singleton pre-v0 dispatcher workflow.
	LegacyDispatcher LegacyExecutionKind = "dispatcher"
	// LegacyTicket is one pre-v0 ticket workflow.
	LegacyTicket LegacyExecutionKind = "ticket"
)

// LegacyExecution is the SDK-free execution snapshot exposed to cutover.
type LegacyExecution struct {
	ID     string
	RunID  string
	Kind   LegacyExecutionKind
	Type   string
	Status string
}

type cutoverClient interface {
	ListWorkflow(context.Context, *workflowservice.ListWorkflowExecutionsRequest) (*workflowservice.ListWorkflowExecutionsResponse, error)
	SignalWorkflow(context.Context, string, string, string, interface{}) error
	CancelWorkflow(context.Context, string, string) error
	DescribeWorkflowExecution(context.Context, string, string) (*workflowservice.DescribeWorkflowExecutionResponse, error)
	TerminateWorkflow(context.Context, string, string, string, ...interface{}) error
}

// LegacyController seals Temporal SDK requests and error classification behind
// the exact domain operations the one-time cutover needs.
type LegacyController struct {
	client    cutoverClient
	namespace string
	clock     clock.Clock
}

// NewLegacyController binds the cutover controller to one namespace.
func NewLegacyController(temporal client.Client, namespace string, clk clock.Clock) *LegacyController {
	return &LegacyController{client: temporal, namespace: namespace, clock: clk}
}

// List returns every still-running legacy dispatcher or ticket execution.
func (controller *LegacyController) List(ctx context.Context) ([]LegacyExecution, error) {
	request := &workflowservice.ListWorkflowExecutionsRequest{
		Namespace: controller.namespace,
		PageSize:  100,
		Query:     `ExecutionStatus = 'Running' AND (WorkflowType = 'FactoryDispatcher' OR WorkflowType = 'FactoryWorkTicket')`,
	}
	result := make([]LegacyExecution, 0)
	for {
		response, err := controller.client.ListWorkflow(ctx, request)
		if err != nil {
			return nil, fmt.Errorf("listing running legacy workflows: %w", err)
		}
		for _, execution := range response.Executions {
			kind := LegacyTicket
			if execution.GetType().GetName() == "FactoryDispatcher" {
				kind = LegacyDispatcher
			}
			result = append(result, LegacyExecution{
				ID:     execution.GetExecution().GetWorkflowId(),
				RunID:  execution.GetExecution().GetRunId(),
				Kind:   kind,
				Type:   execution.GetType().GetName(),
				Status: execution.GetStatus().String(),
			})
		}
		if len(response.NextPageToken) == 0 {
			return result, nil
		}
		request.NextPageToken = response.NextPageToken
	}
}

// PauseDispatcher stops the legacy dispatcher from admitting more ticket work.
func (controller *LegacyController) PauseDispatcher(ctx context.Context) error {
	paused := true
	reason := cutoverTerminationReason
	err := controller.client.SignalWorkflow(ctx, work.FactoryDispatcherWorkflowID, "", workflows.SignalUpdateConfig, work.ConfigUpdate{
		Paused: &paused, PauseReason: &reason,
	})
	if err != nil {
		return fmt.Errorf("signaling the legacy dispatcher pause: %w", err)
	}
	return nil
}

// Cancel asks a legacy execution to perform cooperative cleanup.
func (controller *LegacyController) Cancel(ctx context.Context, execution LegacyExecution) error {
	err := controller.client.CancelWorkflow(ctx, execution.ID, execution.RunID)
	if isCutoverNotFound(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("canceling legacy workflow %s/%s: %w", execution.ID, execution.RunID, err)
	}
	return nil
}

// AwaitClosed waits up to grace for an execution to leave the running state.
func (controller *LegacyController) AwaitClosed(ctx context.Context, execution LegacyExecution, grace time.Duration) (bool, error) {
	deadline := controller.clock.Now().Add(grace)
	for {
		description, err := controller.client.DescribeWorkflowExecution(ctx, execution.ID, execution.RunID)
		if isCutoverNotFound(err) {
			return true, nil
		}
		if err != nil {
			return false, fmt.Errorf("describing legacy workflow %s/%s: %w", execution.ID, execution.RunID, err)
		}
		if description.GetWorkflowExecutionInfo().GetStatus() != enumspb.WORKFLOW_EXECUTION_STATUS_RUNNING {
			return true, nil
		}
		remaining := deadline.Sub(controller.clock.Now())
		if remaining <= 0 {
			return false, nil
		}
		if err := controller.clock.Sleep(ctx, min(remaining, time.Second)); err != nil {
			return false, fmt.Errorf("waiting for legacy workflow %s/%s to close: %w", execution.ID, execution.RunID, err)
		}
	}
}

// Terminate forcibly closes an execution which did not cancel in time.
func (controller *LegacyController) Terminate(ctx context.Context, execution LegacyExecution) error {
	err := controller.client.TerminateWorkflow(ctx, execution.ID, execution.RunID, cutoverTerminationReason)
	if isCutoverNotFound(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("terminating legacy workflow %s/%s: %w", execution.ID, execution.RunID, err)
	}
	return nil
}

func isCutoverNotFound(err error) bool {
	var notFound *serviceerror.NotFound
	return errors.As(err, &notFound)
}
