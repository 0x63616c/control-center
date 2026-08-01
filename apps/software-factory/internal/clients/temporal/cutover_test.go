package temporal

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock/clocktest"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	workflowservice "go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/converter"
)

type fakeCutoverClient struct {
	statuses []work.FactoryDispatcherStatus
	queries  int
	signal   work.ConfigUpdate
}

func (fake *fakeCutoverClient) ListWorkflow(context.Context, *workflowservice.ListWorkflowExecutionsRequest) (*workflowservice.ListWorkflowExecutionsResponse, error) {
	return &workflowservice.ListWorkflowExecutionsResponse{}, nil
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
