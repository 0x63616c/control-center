package agentactivities_test

import (
	"fmt"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	agentactivities "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/blobs"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/prompts"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

type recordingPromptRenderer struct {
	prompt string
	schema []byte
	key    work.StageKey
	detail work.TicketDetail
	prior  work.PriorTurns
}

func (renderer *recordingPromptRenderer) Render(key work.StageKey, detail work.TicketDetail, prior work.PriorTurns) (string, []byte, error) {
	renderer.key, renderer.detail, renderer.prior = key, detail, prior
	return renderer.prompt, renderer.schema, nil
}

func (*recordingPromptRenderer) Decode(work.Stage, []byte) (work.StageOutput, error) {
	return work.StageOutput{}, fmt.Errorf("Decode must not run while preparing")
}

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

func TestPrepareRendersTheStageAndStoresReferenceBackedModelInput(t *testing.T) {
	t.Parallel()

	renderer := &recordingPromptRenderer{
		prompt: "implement the ticket using the available tools",
		schema: []byte(`{"type":"object","properties":{"report":{"type":"string"}},"required":["report"],"additionalProperties":false}`),
	}
	blobStore := blobs.NewMemStore()
	promptActivities, err := agentactivities.NewPromptActivities(renderer, blobStore)
	if err != nil {
		t.Fatalf("NewPromptActivities() error = %v", err)
	}
	attempt := activities.StageAttempt{
		Key:     work.StageKey{Ticket: 7, RunID: "run-7", Stage: work.StageImplement, Turn: 2},
		Sandbox: "sandbox-7", Model: work.Model{Name: "gpt-test", Effort: "medium"},
		Detail: work.TicketDetail{Ticket: work.Ticket{Number: 7, Title: "Do the work", Body: "Please ship it"}},
	}
	prepared, err := promptActivities.Prepare(t.Context(), agentactivities.PrepareInput{Attempt: attempt, CacheKey: "run-7-implement"})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
	if renderer.key != attempt.Key || renderer.detail != attempt.Detail {
		t.Fatalf("Render input key=%#v detail=%#v", renderer.key, renderer.detail)
	}
	if prepared.PromptCacheKey != "run-7-implement" || prepared.ResponseFormat.Name != "implement_result" {
		t.Fatalf("Prepare() output = %#v", prepared)
	}
	items, err := agent.NewConversationStore(blobStore).Items(t.Context(), prepared.ConversationRef)
	if err != nil {
		t.Fatalf("Items() error = %v", err)
	}
	if len(items) != 2 || items[0].Kind != agent.ItemInstructions || items[1].Kind != agent.ItemUserText ||
		items[1].Text != renderer.prompt {
		t.Fatalf("prepared conversation items = %#v", items)
	}
	schema, err := agent.NewArtifactStore(blobStore).LoadResponseSchema(t.Context(), prepared.ResponseFormat.SchemaRef)
	if err != nil {
		t.Fatalf("LoadResponseSchema() error = %v", err)
	}
	if string(schema) != string(renderer.schema) {
		t.Fatalf("stored response schema = %s, want %s", schema, renderer.schema)
	}
}

var _ agentactivities.PromptRenderer = decodingPromptRenderer{}
var _ agentactivities.PromptRenderer = (*recordingPromptRenderer)(nil)
