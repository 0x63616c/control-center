package agentactivities_test

import (
	"context"
	"testing"

	agentactivities "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agenttool"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/blobs"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codexresponses"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

type fakeTurner struct {
	request codexresponses.TurnRequest
	result  codexresponses.TurnResult
	err     error
}

func (turner *fakeTurner) Turn(
	_ context.Context,
	request codexresponses.TurnRequest,
	_ codexresponses.EmitFunc,
) (codexresponses.TurnResult, error) {
	turner.request = request
	return turner.result, turner.err
}

func TestModelTurnLoadsConversationAndStoresFinalText(t *testing.T) {
	t.Parallel()

	blobStore := blobs.NewMemStore()
	conversations := agent.NewConversationStore(blobStore)
	conversationRef, err := conversations.Append(t.Context(), "agent/run-7/plan", nil, []agent.ConversationItem{
		{Kind: agent.ItemInstructions, Text: "Work carefully."},
		{Kind: agent.ItemUserText, Text: "Design the change."},
	})
	if err != nil {
		t.Fatalf("Append() error = %v", err)
	}
	turner := &fakeTurner{result: codexresponses.TurnResult{
		Outcome: codexresponses.OutcomeFinalText,
		Text:    `{"summary":"done"}`,
		Usage:   codexresponses.Usage{InputTokens: 12, OutputTokens: 3},
	}}
	activities, err := agentactivities.NewActivities(
		turner,
		blobStore,
		agenttool.MustSet("coding-read-v1"),
	)
	if err != nil {
		t.Fatalf("NewActivities() error = %v", err)
	}

	result, err := activities.ModelTurn(t.Context(), agent.ModelTurnInput{
		Model:           work.Model{Name: "gpt-test", Effort: "medium"},
		ToolsetID:       "coding-read-v1",
		ConversationRef: conversationRef,
		PromptCacheKey:  "run-7-plan",
		ModelTurn:       1,
		IdempotencyKey:  "agent/run-7/plan/model/1",
	})
	if err != nil {
		t.Fatalf("ModelTurn() error = %v", err)
	}
	if turner.request.Instructions != "Work carefully." || len(turner.request.Input) != 1 ||
		turner.request.Input[0].Text != "Design the change." || turner.request.Model != "gpt-test" {
		t.Fatalf("Turn() request = %#v", turner.request)
	}
	if turner.request.Store || turner.request.ParallelToolCalls {
		t.Fatalf("Turn() request enables provider storage or parallel tools: %#v", turner.request)
	}
	if result.Outcome != agent.OutcomeFinalText || result.ConversationRef.Revision != 1 {
		t.Fatalf("ModelTurn() result = %#v", result)
	}
	if result.Usage != (work.Usage{InputTokens: 12, OutputTokens: 3}) || !result.UsageMeasured {
		t.Fatalf("ModelTurn() usage = %#v, measured = %t", result.Usage, result.UsageMeasured)
	}
	text, err := agent.NewArtifactStore(blobStore).LoadText(t.Context(), result.FinalTextRef)
	if err != nil {
		t.Fatalf("LoadText() error = %v", err)
	}
	if text != `{"summary":"done"}` {
		t.Fatalf("LoadText() = %q", text)
	}
}
