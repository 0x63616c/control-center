package agentpoc_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agentpoc"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codexresponses"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock/clocktest"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/testsuite"
)

type fakeTurnClient struct {
	result  codexresponses.TurnResult
	err     error
	request codexresponses.TurnRequest
	events  []codexresponses.Event
}

func (f *fakeTurnClient) Turn(
	_ context.Context,
	request codexresponses.TurnRequest,
	emit codexresponses.EmitFunc,
) (codexresponses.TurnResult, error) {
	f.request = request
	for _, event := range f.events {
		emit(event)
	}
	return f.result, f.err
}

func TestModelTurnActivityDelegatesAndHeartbeatsWithoutChunkContent(t *testing.T) {
	t.Parallel()

	client := &fakeTurnClient{
		result: codexresponses.TurnResult{Outcome: codexresponses.OutcomeFinalText, Text: "done"},
		events: []codexresponses.Event{
			{Type: codexresponses.EventReasoningDelta, Delta: "private transient reasoning"},
			{Type: codexresponses.EventTextDelta, Delta: "done"},
		},
	}
	activities, err := agentpoc.NewActivities(client, clocktest.NewFake(time.Date(2026, time.July, 31, 12, 0, 0, 0, time.UTC)))
	if err != nil {
		t.Fatalf("constructing activities: %v", err)
	}
	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(activities)
	var heartbeats []agentpoc.StreamProgress
	env.SetOnActivityHeartbeatListener(func(_ *activity.Info, details converter.EncodedValues) {
		var progress agentpoc.StreamProgress
		if err := details.Get(&progress); err != nil {
			t.Errorf("decoding heartbeat: %v", err)
			return
		}
		heartbeats = append(heartbeats, progress)
	})

	input := agentpoc.ModelTurnInput{
		Model: "gpt-test", PromptCacheKey: "activity-test", RequireTool: true,
		Items: []agentpoc.ConversationItem{{Kind: agentpoc.ItemUserText, Text: "hello"}},
	}
	encoded, err := env.ExecuteActivity(activities.ModelTurn, input)
	if err != nil {
		t.Fatalf("executing activity: %v", err)
	}
	var result agentpoc.ModelTurnResult
	if err := encoded.Get(&result); err != nil {
		t.Fatalf("decoding result: %v", err)
	}
	if client.request.Model != "gpt-test" || client.request.ToolChoice != codexresponses.ToolChoiceRequired ||
		len(client.request.Input) != 1 || result.Text != "done" {
		t.Fatalf("request = %#v, result = %#v", client.request, result)
	}
	if len(heartbeats) == 0 || heartbeats[0].Events < 1 || heartbeats[0].Events > 2 || heartbeats[0].EventType == "" {
		t.Fatalf("heartbeats = %#v", heartbeats)
	}
}

func TestToolActivityEnforcesTheAllowlist(t *testing.T) {
	t.Parallel()

	activities, err := agentpoc.NewActivities(&fakeTurnClient{}, clocktest.NewFake(time.Date(2026, time.July, 31, 12, 0, 0, 0, time.UTC)))
	if err != nil {
		t.Fatalf("constructing activities: %v", err)
	}
	output, err := activities.Tool(context.Background(), agentpoc.ToolInput{Call: agentpoc.ToolCall{
		CallID: "call_1", Name: agentpoc.PrototypeToolName, Arguments: []byte(`{"key":"temporal"}`),
	}})
	if err != nil {
		t.Fatalf("executing allowed tool: %v", err)
	}
	if output.CallID != "call_1" || output.Output != `{"value":"Temporal durably resumes work after worker failure."}` {
		t.Fatalf("output = %#v", output)
	}

	_, err = activities.Tool(context.Background(), agentpoc.ToolInput{Call: agentpoc.ToolCall{
		CallID: "call_2", Name: "run_shell", Arguments: []byte(`{}`),
	}})
	if err == nil {
		t.Fatal("unknown tool was allowed")
	}
	var applicationError interface{ NonRetryable() bool }
	if !errors.As(err, &applicationError) || !applicationError.NonRetryable() {
		t.Fatalf("error = %v, want non-retryable allowlist rejection", err)
	}
}
