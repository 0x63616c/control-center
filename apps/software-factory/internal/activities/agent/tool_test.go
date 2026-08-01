package agentactivities_test

import (
	"context"
	"testing"
	"time"

	agentactivities "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agenttool"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/blobs"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock/clocktest"
)

type countedInput struct {
	Value string `json:"value" jsonschema_description:"Value returned by the test tool."`
}

func TestToolRetryReturnsTheRecordedResultWithoutExecutingTwice(t *testing.T) {
	t.Parallel()

	blobStore := blobs.NewMemStore()
	conversations := agent.NewConversationStore(blobStore)
	initial, err := conversations.Append(t.Context(), "agent/run-7/implement/1", nil, []agent.ConversationItem{{
		Kind: agent.ItemUserText, Text: "Use the tool.",
	}})
	if err != nil {
		t.Fatalf("Append(initial) error = %v", err)
	}
	arguments := []byte(`{"value":"once"}`)
	requested, err := conversations.Append(t.Context(), "agent/run-7/implement/1", &initial, []agent.ConversationItem{{
		Kind: agent.ItemFunctionCall, ID: "fc_1", CallID: "call_1", Name: "counted", Arguments: arguments,
	}})
	if err != nil {
		t.Fatalf("Append(requested) error = %v", err)
	}
	argumentsRef, err := agent.NewArtifactStore(blobStore).StoreArguments(
		t.Context(), "agent/run-7/implement/1", arguments,
	)
	if err != nil {
		t.Fatalf("StoreArguments() error = %v", err)
	}
	transcriptRef, err := agent.NewTranscriptStore(blobStore).Append(
		t.Context(), "agent/run-7/implement/1", nil, agent.TranscriptEvent{Type: agent.EventWorkflowPrepared},
	)
	if err != nil {
		t.Fatalf("start transcript: %v", err)
	}
	executions := 0
	tool := agenttool.Bind(
		agenttool.Define[countedInput]("counted", "Return one value while counting executions."),
		func(_ context.Context, input countedInput) (agenttool.Result, error) {
			executions++
			return agenttool.Result{Content: input.Value}, nil
		},
	)
	activities, err := agentactivities.NewToolActivities(
		blobStore, clocktest.NewFake(time.Unix(0, 0)), agenttool.MustSet("coding-write-v1", tool),
	)
	if err != nil {
		t.Fatalf("NewToolActivities() error = %v", err)
	}
	input := agent.ToolInput{
		ToolsetID:       "coding-write-v1",
		ConversationRef: requested,
		TranscriptRef:   transcriptRef,
		Call:            agent.PendingToolCall{CallID: "call_1", Name: "counted", ArgumentsRef: argumentsRef},
	}
	first, err := activities.Tool(t.Context(), input)
	if err != nil {
		t.Fatalf("first Tool() error = %v", err)
	}
	second, err := activities.Tool(t.Context(), input)
	if err != nil {
		t.Fatalf("second Tool() error = %v", err)
	}
	if executions != 1 {
		t.Fatalf("tool executions = %d, want 1", executions)
	}
	if first != second || first.CallID != "call_1" || first.ConversationRef.Revision != 2 {
		t.Fatalf("tool results = %#v and %#v", first, second)
	}
	if first.TranscriptRef.Revision != 1 {
		t.Fatalf("tool transcript ref = %#v", first.TranscriptRef)
	}
	items, err := conversations.Items(t.Context(), first.ConversationRef)
	if err != nil {
		t.Fatalf("Items() error = %v", err)
	}
	if last := items[len(items)-1]; last.Kind != agent.ItemFunctionOutput || last.CallID != "call_1" || last.Output != "once" {
		t.Fatalf("stored tool output = %#v", last)
	}
}
