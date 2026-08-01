package agentactivities_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	agentactivities "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agenttool"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/blobs"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codexresponses"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/sdk/temporal"
)

type readFileInput struct {
	Path string `json:"path" jsonschema_description:"Repository-relative path to read."`
}

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
	if turner.request.IdempotencyKey != "agent/run-7/plan/model/1" {
		t.Fatalf("Turn() idempotency key = %q", turner.request.IdempotencyKey)
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

func TestModelTurnStoresToolArgumentsAndPreservesCallIDs(t *testing.T) {
	t.Parallel()

	blobStore := blobs.NewMemStore()
	conversations := agent.NewConversationStore(blobStore)
	conversationRef, err := conversations.Append(t.Context(), "agent/run-7/implement/1", nil, []agent.ConversationItem{
		{Kind: agent.ItemInstructions, Text: "Edit carefully."},
		{Kind: agent.ItemUserText, Text: "Implement the change."},
	})
	if err != nil {
		t.Fatalf("Append() error = %v", err)
	}
	arguments := []byte(`{"path":"internal/work/work.go"}`)
	turner := &fakeTurner{result: codexresponses.TurnResult{
		Outcome: codexresponses.OutcomeToolCalls,
		ToolCalls: []codexresponses.ToolCall{{
			ID: "fc_1", CallID: "call_1", Name: "read_file", Arguments: arguments,
		}},
		Usage: codexresponses.Usage{InputTokens: 20, OutputTokens: 4},
	}}
	readFile := agenttool.Bind(
		agenttool.Define[readFileInput]("read_file", "Read one repository file."),
		func(_ context.Context, _ readFileInput) (agenttool.Result, error) { return agenttool.Result{}, nil },
	)
	activities, err := agentactivities.NewActivities(
		turner,
		blobStore,
		agenttool.MustSet("coding-write-v1", readFile),
	)
	if err != nil {
		t.Fatalf("NewActivities() error = %v", err)
	}

	result, err := activities.ModelTurn(t.Context(), agent.ModelTurnInput{
		Model:           work.Model{Name: "gpt-test", Effort: "medium"},
		ToolsetID:       "coding-write-v1",
		ConversationRef: conversationRef,
		PromptCacheKey:  "run-7-implement-1",
		ModelTurn:       1,
		IdempotencyKey:  "agent/run-7/implement/1/model/1",
	})
	if err != nil {
		t.Fatalf("ModelTurn() error = %v", err)
	}
	if result.Outcome != agent.OutcomeToolCalls || len(result.ToolCalls) != 1 {
		t.Fatalf("ModelTurn() result = %#v", result)
	}
	pending := result.ToolCalls[0]
	if pending.CallID != "call_1" || pending.Name != "read_file" {
		t.Fatalf("pending tool call = %#v", pending)
	}
	storedArguments, err := agent.NewArtifactStore(blobStore).LoadArguments(t.Context(), pending.ArgumentsRef)
	if err != nil {
		t.Fatalf("LoadArguments() error = %v", err)
	}
	if !reflect.DeepEqual(storedArguments, arguments) {
		t.Fatalf("LoadArguments() = %s, want %s", storedArguments, arguments)
	}
	items, err := conversations.Items(t.Context(), result.ConversationRef)
	if err != nil {
		t.Fatalf("Items() error = %v", err)
	}
	last := items[len(items)-1]
	if last.Kind != agent.ItemFunctionCall || last.ID != "fc_1" || last.CallID != "call_1" ||
		last.Name != "read_file" || !reflect.DeepEqual([]byte(last.Arguments), arguments) {
		t.Fatalf("stored function call = %#v", last)
	}
}

func TestModelTurnRejectsIncompleteProviderOutcomes(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		result codexresponses.TurnResult
	}{
		{name: "blank final text", result: codexresponses.TurnResult{Outcome: codexresponses.OutcomeFinalText}},
		{name: "blank provider item id", result: codexresponses.TurnResult{
			Outcome:   codexresponses.OutcomeToolCalls,
			ToolCalls: []codexresponses.ToolCall{{CallID: "call_1", Name: "read_file", Arguments: []byte(`{}`)}},
		}},
		{name: "blank call id", result: codexresponses.TurnResult{
			Outcome:   codexresponses.OutcomeToolCalls,
			ToolCalls: []codexresponses.ToolCall{{ID: "fc_1", Name: "read_file", Arguments: []byte(`{}`)}},
		}},
		{name: "blank name", result: codexresponses.TurnResult{
			Outcome:   codexresponses.OutcomeToolCalls,
			ToolCalls: []codexresponses.ToolCall{{ID: "fc_1", CallID: "call_1", Arguments: []byte(`{}`)}},
		}},
		{name: "invalid arguments", result: codexresponses.TurnResult{
			Outcome:   codexresponses.OutcomeToolCalls,
			ToolCalls: []codexresponses.ToolCall{{ID: "fc_1", CallID: "call_1", Name: "read_file", Arguments: []byte(`{`)}},
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			blobStore := blobs.NewMemStore()
			conversations := agent.NewConversationStore(blobStore)
			conversationRef, err := conversations.Append(t.Context(), "agent/run-invalid/plan", nil, []agent.ConversationItem{
				{Kind: agent.ItemInstructions, Text: "Work carefully."},
				{Kind: agent.ItemUserText, Text: "Design the change."},
			})
			if err != nil {
				t.Fatalf("Append() error = %v", err)
			}
			activities, err := agentactivities.NewActivities(
				&fakeTurner{result: test.result},
				blobStore,
				agenttool.MustSet("coding-read-v1"),
			)
			if err != nil {
				t.Fatalf("NewActivities() error = %v", err)
			}

			_, err = activities.ModelTurn(t.Context(), agent.ModelTurnInput{
				Model: work.Model{Name: "gpt-test", Effort: "medium"}, ToolsetID: "coding-read-v1",
				ConversationRef: conversationRef, IdempotencyKey: "agent/run-invalid/plan/model/1",
			})
			var applicationError *temporal.ApplicationError
			if !errors.As(err, &applicationError) || applicationError.Type() != agent.ErrorTypeInvalidProviderOutcome ||
				!applicationError.NonRetryable() {
				t.Fatalf("ModelTurn() error = %T %v, want non-retryable %q", err, err, agent.ErrorTypeInvalidProviderOutcome)
			}
		})
	}
}
