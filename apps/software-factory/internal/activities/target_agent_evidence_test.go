package activities

import (
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/blobs"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store/storefake"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

func TestTargetAgentEvidenceRequiresAnExplicitWellFormedState(t *testing.T) {
	t.Parallel()
	activities, err := NewTargetAgentEvidenceActivities(storefake.New(), blobs.NewMemStore())
	if err != nil {
		t.Fatalf("NewTargetAgentEvidenceActivities: %v", err)
	}
	base := TargetAgentEvidenceInput{
		AttemptID: store.TargetAttemptID{RunID: "019fb901-0000-7000-8000-000000000001", StepOrdinal: 1, AttemptNo: 1},
		Identity:  "agent/019fb901-0000-7000-8000-000000000001/step/1/attempt/1",
		EndedAt:   time.Now().UTC(),
	}
	for _, test := range []struct {
		name  string
		input TargetAgentEvidenceInput
	}{
		{name: "missing state", input: base},
		{name: "blank failed reason", input: func() TargetAgentEvidenceInput { value := base; value.State = work.AgentAttemptFailed; return value }()},
		{name: "running terminal", input: func() TargetAgentEvidenceInput { value := base; value.State = work.AgentAttemptRunning; return value }()},
		{name: "failed result", input: func() TargetAgentEvidenceInput {
			value := base
			value.State, value.FailureKind = work.AgentAttemptFailed, work.RunFailureAgentUnrecoverable
			value.Result = work.NewStageOutput(work.StagePlan, work.DocumentOutput{Document: "not allowed"})
			return value
		}()},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := activities.Finalize(t.Context(), test.input); err == nil {
				t.Fatal("Finalize() succeeded, want invalid evidence failure")
			}
		})
	}
}
