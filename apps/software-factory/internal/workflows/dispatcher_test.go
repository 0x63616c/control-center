package workflows_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
	"github.com/stretchr/testify/mock"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"
)

func TestDispatcherRollsOverOnlyFromTemporalsSuggestionAndCarriesNoLiveState(t *testing.T) {
	t.Parallel()

	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestWorkflowEnvironment()
	env.SetContinueAsNewSuggested(true)
	in := workflows.DispatcherInput{
		Policy:   work.DefaultDispatcherPolicy(),
		CloneURL: "https://github.com/example/repository.git",
		Model:    work.Model{Name: "gpt-5", Effort: "high"},
	}
	env.ExecuteWorkflow(workflows.Dispatcher, in)

	var continued *workflow.ContinueAsNewError
	if err := env.GetWorkflowError(); !errors.As(err, &continued) {
		t.Fatalf("Dispatcher error = %v, want ContinueAsNewError", err)
	}
	var next workflows.DispatcherInput
	if err := converter.GetDefaultDataConverter().FromPayloads(continued.Input, &next); err != nil {
		t.Fatalf("decoding continue-as-new input: %v", err)
	}
	if next.CloneURL != in.CloneURL || next.Model != in.Model {
		t.Fatalf("continued dispatcher input = %+v, want source configuration retained", next)
	}
	got, err := next.Policy.Fingerprint()
	if err != nil {
		t.Fatalf("fingerprinting continued policy: %v", err)
	}
	want, err := in.Policy.Fingerprint()
	if err != nil {
		t.Fatalf("fingerprinting input policy: %v", err)
	}
	if got != want {
		t.Fatalf("continued policy fingerprint = %q, want %q", got, want)
	}
}

func TestDispatcherPublishesTheLatestAcceptedPolicy(t *testing.T) {
	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestWorkflowEnvironment()
	env.OnActivity(ticketActs.AwaitDispatchableTickets, mock.Anything).
		Return([]store.Ticket{}, temporal.NewApplicationError("no dispatchable tickets", activities.ErrTypeNoDispatchableTickets, nil))

	in := targetDispatcherInput()
	first := in.Policy
	first.MaxInFlight = 2
	second := in.Policy
	second.MaxInFlight = 3
	updates := map[string]workflows.DispatcherPublication{}
	errs := map[string]error{}
	env.RegisterDelayedCallback(func() {
		env.UpdateWorkflow(workflows.UpdateDispatcherPolicy, "publication-first", dispatcherUpdateCallback("first", updates, errs), targetDispatcherPolicyUpdate(t, first))
		env.UpdateWorkflow(workflows.UpdateDispatcherPolicy, "publication-second", dispatcherUpdateCallback("second", updates, errs), targetDispatcherPolicyUpdate(t, second))
		env.UpdateWorkflow(workflows.UpdateDispatcherPolicy, "publication-second", dispatcherUpdateCallback("second-retry", updates, errs), targetDispatcherPolicyUpdate(t, second))
		env.UpdateWorkflow(workflows.UpdateDispatcherPolicy, "publication-second-comparison", dispatcherUpdateCallback("second-comparison", updates, errs), targetDispatcherPolicyUpdate(t, second))
	}, 0)
	env.RegisterDelayedCallback(env.CancelWorkflow, time.Minute)
	env.ExecuteWorkflow(workflows.Dispatcher, in)

	if err := env.GetWorkflowError(); !temporal.IsCanceledError(err) {
		t.Fatalf("Dispatcher error = %v, want cancellation after update assertions", err)
	}
	for name, err := range errs {
		if err != nil {
			t.Errorf("%s publication failed: %v", name, err)
		}
	}
	if got := updates["first"]; got != workflows.DispatcherPublicationApplied {
		t.Errorf("first publication = %q, want APPLIED", got)
	}
	if got := updates["second"]; got != workflows.DispatcherPublicationApplied {
		t.Errorf("second publication = %q, want APPLIED", got)
	}
	if got := updates["second-retry"]; got != workflows.DispatcherPublicationApplied {
		t.Errorf("duplicate request publication = %q, want original APPLIED response", got)
	}
	if got := updates["second-comparison"]; got != workflows.DispatcherPublicationAlreadyCurrent {
		t.Errorf("repeated latest policy under a new request = %q, want ALREADY_CURRENT", got)
	}
}

func TestDispatcherDrainsTrackedChildrenBeforeContinuingAsNew(t *testing.T) {
	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestWorkflowEnvironment()
	awaits := 0
	env.OnActivity(ticketActs.AwaitDispatchableTickets, mock.Anything).
		Return(func(context.Context) ([]store.Ticket, error) {
			awaits++
			return []store.Ticket{{ID: 42, Title: "dispatch me", State: store.TicketOpen}}, nil
		})
	env.OnWorkflow(workflows.WorkOnTicket, mock.Anything, mock.Anything).
		Return(func(ctx workflow.Context, _ workflows.WorkOnTicketInput) error {
			return workflow.Sleep(ctx, time.Minute)
		})

	in := targetDispatcherInput()
	env.RegisterDelayedCallback(func() {
		env.SetContinueAsNewSuggested(true)
		env.UpdateWorkflowNoRejection(workflows.UpdateDispatcherPolicy, "wake-for-drain", t, targetDispatcherPolicyUpdate(t, in.Policy))
	}, 10*time.Second)
	env.ExecuteWorkflow(workflows.Dispatcher, in)

	var continued *workflow.ContinueAsNewError
	if err := env.GetWorkflowError(); !errors.As(err, &continued) {
		t.Fatalf("Dispatcher error = %v, want ContinueAsNewError", err)
	}
	if awaits != 1 {
		t.Errorf("AwaitDispatchableTickets calls = %d, want exactly one before drain", awaits)
	}
}

func targetDispatcherInput() workflows.DispatcherInput {
	return workflows.DispatcherInput{
		Policy:   work.DefaultDispatcherPolicy(),
		CloneURL: "https://github.com/example/repository.git",
		Model:    work.Model{Name: "gpt-5", Effort: "high"},
	}
}

func targetDispatcherPolicyUpdate(t *testing.T, policy work.DispatcherPolicy) workflows.DispatcherPolicyUpdate {
	t.Helper()
	fingerprint, err := policy.Fingerprint()
	if err != nil {
		t.Fatalf("fingerprinting policy: %v", err)
	}
	return workflows.DispatcherPolicyUpdate{Fingerprint: fingerprint, Policy: policy}
}

func dispatcherUpdateCallback(name string, updates map[string]workflows.DispatcherPublication, errs map[string]error) *testsuite.TestUpdateCallback {
	return &testsuite.TestUpdateCallback{
		OnReject: func(err error) { errs[name] = err },
		OnAccept: func() {},
		OnComplete: func(value interface{}, err error) {
			if err != nil {
				errs[name] = err
				return
			}
			publication, ok := value.(workflows.DispatcherPublication)
			if !ok {
				errs[name] = fmt.Errorf("unexpected publication type %T", value)
				return
			}
			updates[name] = publication
		},
	}
}
