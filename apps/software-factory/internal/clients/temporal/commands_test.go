package temporal

import (
	"context"
	"errors"
	"testing"

	"go.temporal.io/api/serviceerror"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
)

type fakeClient struct {
	workflowID string
	signal     string
	payload    interface{}
	canceledID string
	err        error
}

func (fake *fakeClient) SignalWorkflow(_ context.Context, workflowID, _ string, signal string, payload interface{}) error {
	fake.workflowID, fake.signal, fake.payload = workflowID, signal, payload
	return fake.err
}

func (fake *fakeClient) CancelWorkflow(_ context.Context, workflowID, _ string) error {
	fake.canceledID = workflowID
	return fake.err
}

func TestCommandsUseTheSharedWorkflowIDsAndControlSignal(t *testing.T) {
	t.Parallel()

	fake := &fakeClient{}
	commands := &Commands{client: fake}
	paused := true
	update := work.ConfigUpdate{Paused: &paused}
	if err := commands.UpdateConfig(context.Background(), update); err != nil {
		t.Fatalf("UpdateConfig() error = %v", err)
	}
	if fake.workflowID != work.DispatcherWorkflowID || fake.signal != workflows.SignalUpdateConfig || fake.payload != update {
		t.Fatalf("signal = (%q, %q, %#v), want dispatcher UpdateConfig", fake.workflowID, fake.signal, fake.payload)
	}
	if err := commands.CancelTicket(context.Background(), 42); err != nil {
		t.Fatalf("CancelTicket() error = %v", err)
	}
	if fake.canceledID != work.WorkflowID(42) {
		t.Fatalf("canceled workflow ID = %q, want %q", fake.canceledID, work.WorkflowID(42))
	}
}

func TestCommandsPreserveTemporalFailureKinds(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name string
		err  error
		want error
	}{
		{"not found", serviceerror.NewNotFound("missing"), work.ErrWorkflowNotFound},
		{"closed", serviceerror.NewFailedPrecondition("closed"), work.ErrWorkflowClosed},
	} {
		t.Run(test.name, func(t *testing.T) {
			commands := &Commands{client: &fakeClient{err: test.err}}
			err := commands.CancelTicket(context.Background(), 42)
			if !errors.Is(err, test.want) {
				t.Fatalf("CancelTicket() error = %v, want %v", err, test.want)
			}
		})
	}
}
