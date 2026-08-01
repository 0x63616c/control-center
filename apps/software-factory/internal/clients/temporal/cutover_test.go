package temporal

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock/clocktest"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	commonpb "go.temporal.io/api/common/v1"
	enumspb "go.temporal.io/api/enums/v1"
	workflowpb "go.temporal.io/api/workflow/v1"
	workflowservice "go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/converter"
)

type fakeCutoverClient struct {
	statuses     []work.FactoryDispatcherStatus
	queries      int
	signal       work.ConfigUpdate
	listRequests []*workflowservice.ListWorkflowExecutionsRequest
	listed       []*workflowservice.ListWorkflowExecutionsResponse
}

func (fake *fakeCutoverClient) ListWorkflow(_ context.Context, request *workflowservice.ListWorkflowExecutionsRequest) (*workflowservice.ListWorkflowExecutionsResponse, error) {
	fake.listRequests = append(fake.listRequests, request)
	if len(fake.listed) == 0 {
		return &workflowservice.ListWorkflowExecutionsResponse{}, nil
	}
	response := fake.listed[0]
	fake.listed = fake.listed[1:]
	return response, nil
}

func TestListIncludesPreActivationAgentWorkflowChildren(t *testing.T) {
	t.Parallel()
	fake := &fakeCutoverClient{listed: []*workflowservice.ListWorkflowExecutionsResponse{
		{Executions: []*workflowpb.WorkflowExecutionInfo{
			{Execution: &commonpb.WorkflowExecution{WorkflowId: "software-factory-ticket-dispatcher", RunId: "dispatcher-run"}, Type: &commonpb.WorkflowType{Name: "FactoryDispatcher"}, Status: enumspb.WORKFLOW_EXECUTION_STATUS_RUNNING},
			{Execution: &commonpb.WorkflowExecution{WorkflowId: "factory-ticket-8", RunId: "ticket-run"}, Type: &commonpb.WorkflowType{Name: "FactoryWorkTicket"}, Status: enumspb.WORKFLOW_EXECUTION_STATUS_RUNNING},
			{Execution: &commonpb.WorkflowExecution{WorkflowId: "agent/run-8/implement/1", RunId: "agent-run"}, Type: &commonpb.WorkflowType{Name: "AgentWorkflow"}, Status: enumspb.WORKFLOW_EXECUTION_STATUS_RUNNING},
			{Execution: &commonpb.WorkflowExecution{WorkflowId: "agent/run-target/step/5/attempt/1", RunId: "target-agent-run"}, Type: &commonpb.WorkflowType{Name: "AgentWorkflow"}, Status: enumspb.WORKFLOW_EXECUTION_STATUS_RUNNING},
		}},
	}}
	controller := &LegacyController{client: fake, namespace: "software-factory", clock: clocktest.NewFake(time.Date(2026, time.August, 1, 12, 0, 0, 0, time.UTC))}

	listed, err := controller.List(t.Context())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(listed) != 3 || listed[2].Kind != LegacyAgent || listed[2].ID != "agent/run-8/implement/1" {
		t.Fatalf("listed = %+v, want the legacy AgentWorkflow classified and the target agent omitted", listed)
	}
	if len(fake.listRequests) != 1 {
		t.Fatalf("list requests = %d, want 1", len(fake.listRequests))
	}
	wantQuery := `ExecutionStatus = 'Running' AND (WorkflowType = 'FactoryDispatcher' OR WorkflowType = 'FactoryWorkTicket' OR WorkflowType = 'AgentWorkflow')`
	if fake.listRequests[0].Query != wantQuery {
		t.Fatalf("query = %q, want %q", fake.listRequests[0].Query, wantQuery)
	}
}

func (fake *fakeCutoverClient) SignalWorkflow(_ context.Context, _, _, _ string, payload interface{}) error {
	fake.signal = payload.(work.ConfigUpdate)
	return nil
}

func (fake *fakeCutoverClient) CancelWorkflow(context.Context, string, string) error { return nil }

func (fake *fakeCutoverClient) DescribeWorkflowExecution(context.Context, string, string) (*workflowservice.DescribeWorkflowExecutionResponse, error) {
	return &workflowservice.DescribeWorkflowExecutionResponse{}, nil
}

func (fake *fakeCutoverClient) TerminateWorkflow(context.Context, string, string, string, ...interface{}) error {
	return nil
}

func (fake *fakeCutoverClient) QueryWorkflow(context.Context, string, string, string, ...interface{}) (converter.EncodedValue, error) {
	index := min(fake.queries, len(fake.statuses)-1)
	fake.queries++
	return encodedStatus{status: fake.statuses[index]}, nil
}

type encodedStatus struct{ status work.FactoryDispatcherStatus }

func (encodedStatus) HasValue() bool { return true }

func (encoded encodedStatus) Get(target interface{}) error {
	status, ok := target.(*work.FactoryDispatcherStatus)
	if !ok {
		return fmt.Errorf("unexpected query target %T", target)
	}
	*status = encoded.status
	return nil
}

func TestPauseDispatcherWaitsForTheWorkflowToAcknowledgeTheCutoverPause(t *testing.T) {
	clk := clocktest.NewFake(time.Date(2026, time.July, 31, 20, 0, 0, 0, time.UTC))
	paused := work.DefaultFactoryConfig()
	paused.Paused = true
	paused.PauseReason = cutoverTerminationReason
	fake := &fakeCutoverClient{statuses: []work.FactoryDispatcherStatus{
		{Config: work.DefaultFactoryConfig()},
		{Config: paused},
	}}
	controller := &LegacyController{client: fake, namespace: "default", clock: clk}

	if err := controller.PauseDispatcher(context.Background()); err != nil {
		t.Fatalf("PauseDispatcher: %v", err)
	}
	if fake.queries != 2 || len(clk.Slept()) != 1 {
		t.Fatalf("queries = %d sleeps = %v, want one retry before acknowledgment", fake.queries, clk.Slept())
	}
	if fake.signal.Paused == nil || !*fake.signal.Paused || fake.signal.PauseReason == nil || *fake.signal.PauseReason != cutoverTerminationReason {
		t.Fatalf("signal = %+v, want the named cutover pause", fake.signal)
	}
}
