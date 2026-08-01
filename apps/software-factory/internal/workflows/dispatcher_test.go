package workflows_test

import (
	"errors"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
	"go.temporal.io/sdk/converter"
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
