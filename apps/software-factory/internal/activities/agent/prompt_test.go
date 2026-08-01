package agentactivities_test

import (
	"fmt"
	"testing"

	agentactivities "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/blobs"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/prompts"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

type decodingPromptRenderer struct{}

func (decodingPromptRenderer) Render(work.StageKey, work.TicketDetail, work.PriorTurns) (string, []byte, error) {
	return "", nil, fmt.Errorf("Render must not run while finalizing")
}

func (decodingPromptRenderer) Decode(stage work.Stage, result []byte) (work.StageOutput, error) {
	return prompts.Decode(stage, result)
}

func TestFinalizeDecodesEachStageResultFromItsTextReference(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		stage work.Stage
		text  string
		check func(*testing.T, work.StageOutput)
	}{
		{name: "plan", stage: work.StagePlan, text: `{"document":"the plan"}`, check: func(t *testing.T, output work.StageOutput) {
			t.Helper()
			value, ok := output.Value().(work.DocumentOutput)
			if !ok || value.Document != "the plan" {
				t.Fatalf("plan output = %#v", output.Value())
			}
		}},
		{name: "implement", stage: work.StageImplement, text: `{"report":"implemented","blocked":false,"blocked_reason":"","title":"Ship it","body":"Details"}`, check: func(t *testing.T, output work.StageOutput) {
			t.Helper()
			value, ok := output.Value().(work.ImplementOutput)
			if !ok || value.Report != "implemented" || value.Blocked || value.Title != "Ship it" || value.Body != "Details" {
				t.Fatalf("implement output = %#v", output.Value())
			}
		}},
		{name: "review", stage: work.StageReview, text: `{"document":"reviewed","findings":[{"id":"f1","blocking":true,"summary":"fix it"}],"verified":["tests"]}`, check: func(t *testing.T, output work.StageOutput) {
			t.Helper()
			value, ok := output.Value().(work.ReviewOutput)
			if !ok || value.Document != "reviewed" || len(value.Findings) != 1 || value.Findings[0].ID != "f1" || len(value.Verified) != 1 {
				t.Fatalf("review output = %#v", output.Value())
			}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			blobStore := blobs.NewMemStore()
			artifacts := agent.NewArtifactStore(blobStore)
			textRef, err := artifacts.StoreText(t.Context(), "agent/run-7/"+string(test.stage)+"/1", test.text)
			if err != nil {
				t.Fatalf("StoreText() error = %v", err)
			}
			promptActivities, err := agentactivities.NewPromptActivities(decodingPromptRenderer{}, blobStore)
			if err != nil {
				t.Fatalf("NewPromptActivities() error = %v", err)
			}
			finalized, err := promptActivities.Finalize(t.Context(), agentactivities.FinalizeInput{Stage: test.stage, TextRef: textRef})
			if err != nil {
				t.Fatalf("Finalize() error = %v", err)
			}
			if finalized.Result.Stage() != test.stage {
				t.Fatalf("Finalize() stage = %q, want %q", finalized.Result.Stage(), test.stage)
			}
			test.check(t, finalized.Result)
		})
	}
}

var _ agentactivities.PromptRenderer = decodingPromptRenderer{}
