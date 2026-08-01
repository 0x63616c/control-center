package agentpocworkflow_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agentpoc"
	agentpocworkflow "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows/agentpoc"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
)

func TestAgentWorkflowCompletesOnFinalText(t *testing.T) {
	t.Parallel()

	env := newEnvironment(t,
		func(context.Context, agentpoc.ModelTurnInput) (agentpoc.ModelTurnResult, error) {
			return agentpoc.ModelTurnResult{
				Outcome: agentpoc.OutcomeFinalText,
				Text:    "Temporal kept the turn durable.",
				Usage:   agentpoc.Usage{InputTokens: 10, OutputTokens: 6, TotalTokens: 16},
			}, nil
		},
		unexpectedTool(t),
	)

	env.ExecuteWorkflow(agentpocworkflow.Workflow, validInput(3))
	assertCompleted(t, env)
	var result agentpoc.Result
	if err := env.GetWorkflowResult(&result); err != nil {
		t.Fatalf("reading result: %v", err)
	}
	if result.FinalText != "Temporal kept the turn durable." || result.ModelTurns != 1 || result.ToolCalls != 0 || result.Usage.TotalTokens != 16 {
		t.Fatalf("result = %#v", result)
	}
}

func TestAgentWorkflowExecutesToolAndContinuesTheStoredResponse(t *testing.T) {
	t.Parallel()

	var requests []agentpoc.ModelTurnInput
	model := func(_ context.Context, in agentpoc.ModelTurnInput) (agentpoc.ModelTurnResult, error) {
		requests = append(requests, in)
		if len(requests) == 1 {
			return agentpoc.ModelTurnResult{
				Outcome:    agentpoc.OutcomeToolCalls,
				ResponseID: "resp_tool",
				ToolCalls: []agentpoc.ToolCall{{
					ID: "fc_1", CallID: "call_1", Name: agentpoc.PrototypeToolName,
					Arguments: []byte(`{"key":"temporal"}`),
				}},
				Usage: agentpoc.Usage{TotalTokens: 20},
			}, nil
		}
		return agentpoc.ModelTurnResult{
			Outcome: agentpoc.OutcomeFinalText,
			Text:    "The prototype fact is durable execution.",
			Usage:   agentpoc.Usage{TotalTokens: 12},
		}, nil
	}
	var toolCalls []agentpoc.ToolInput
	tool := func(_ context.Context, in agentpoc.ToolInput) (agentpoc.ToolOutput, error) {
		toolCalls = append(toolCalls, in)
		return agentpoc.ToolOutput{CallID: in.Call.CallID, Output: `{"value":"durable execution"}`}, nil
	}
	env := newEnvironment(t, model, tool)

	env.ExecuteWorkflow(agentpocworkflow.Workflow, validInput(3))
	assertCompleted(t, env)
	var result agentpoc.Result
	if err := env.GetWorkflowResult(&result); err != nil {
		t.Fatalf("reading result: %v", err)
	}
	if len(requests) != 2 || len(toolCalls) != 1 {
		t.Fatalf("model requests = %d, tool calls = %d", len(requests), len(toolCalls))
	}
	continuation := requests[1]
	if continuation.RequireTool || len(continuation.Items) != 3 ||
		continuation.Items[1].Kind != agentpoc.ItemFunctionCall || continuation.Items[1].CallID != "call_1" ||
		continuation.Items[2].Kind != agentpoc.ItemFunctionOutput || continuation.Items[2].CallID != "call_1" {
		t.Fatalf("continuation = %#v", continuation)
	}
	if result.FinalText == "" || result.ModelTurns != 2 || result.ToolCalls != 1 || result.Usage.TotalTokens != 32 {
		t.Fatalf("result = %#v", result)
	}
}

func TestAgentWorkflowRetriesTransientModelFailures(t *testing.T) {
	t.Parallel()

	attempts := 0
	var timeoutInfo activity.Info
	env := newEnvironment(t,
		func(ctx context.Context, _ agentpoc.ModelTurnInput) (agentpoc.ModelTurnResult, error) {
			attempts++
			timeoutInfo = activity.GetInfo(ctx)
			if attempts < 3 {
				return agentpoc.ModelTurnResult{}, errors.New("stream interrupted")
			}
			return agentpoc.ModelTurnResult{Outcome: agentpoc.OutcomeFinalText, Text: "recovered"}, nil
		},
		unexpectedTool(t),
	)
	started := env.Now()

	env.ExecuteWorkflow(agentpocworkflow.Workflow, validInput(3))
	assertCompleted(t, env)
	if attempts != 3 {
		t.Fatalf("attempts = %d, want 3", attempts)
	}
	if elapsed := env.Now().Sub(started); elapsed < 3*time.Second {
		t.Fatalf("retry backoff elapsed = %s, want at least 3s", elapsed)
	}
	if timeoutInfo.StartToCloseTimeout != 2*time.Minute || timeoutInfo.HeartbeatTimeout != 15*time.Second {
		t.Fatalf("activity timeouts = start-to-close %s, heartbeat %s", timeoutInfo.StartToCloseTimeout, timeoutInfo.HeartbeatTimeout)
	}
}

func TestAgentWorkflowFailsAtTheTurnLimit(t *testing.T) {
	t.Parallel()

	model := func(_ context.Context, _ agentpoc.ModelTurnInput) (agentpoc.ModelTurnResult, error) {
		return agentpoc.ModelTurnResult{
			Outcome:    agentpoc.OutcomeToolCalls,
			ResponseID: "resp_more",
			ToolCalls: []agentpoc.ToolCall{{
				ID: "fc_more", CallID: "call_more", Name: agentpoc.PrototypeToolName,
				Arguments: []byte(`{"key":"temporal"}`),
			}},
		}, nil
	}
	tool := func(_ context.Context, in agentpoc.ToolInput) (agentpoc.ToolOutput, error) {
		return agentpoc.ToolOutput{CallID: in.Call.CallID, Output: `{"value":"durable execution"}`}, nil
	}
	env := newEnvironment(t, model, tool)

	env.ExecuteWorkflow(agentpocworkflow.Workflow, validInput(2))
	if !env.IsWorkflowCompleted() || env.GetWorkflowError() == nil {
		t.Fatal("workflow did not fail at the turn limit")
	}
	var applicationError *temporal.ApplicationError
	if !errors.As(env.GetWorkflowError(), &applicationError) || applicationError.Type() != agentpoc.TurnLimitErrorType {
		t.Fatalf("error = %v, want non-retryable turn-limit application error", env.GetWorkflowError())
	}
}

func newEnvironment(
	t *testing.T,
	model func(context.Context, agentpoc.ModelTurnInput) (agentpoc.ModelTurnResult, error),
	tool func(context.Context, agentpoc.ToolInput) (agentpoc.ToolOutput, error),
) *testsuite.TestWorkflowEnvironment {
	t.Helper()
	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterActivityWithOptions(model, activity.RegisterOptions{Name: agentpoc.ModelTurnActivityName})
	env.RegisterActivityWithOptions(tool, activity.RegisterOptions{Name: agentpoc.ToolActivityName})
	return env
}

func validInput(maxTurns int) agentpoc.Input {
	return agentpoc.Input{
		Prompt:         "Use the prototype tool to explain the Temporal fact.",
		Model:          "gpt-test",
		MaxTurns:       maxTurns,
		PromptCacheKey: "workflow-test",
	}
}

func unexpectedTool(t *testing.T) func(context.Context, agentpoc.ToolInput) (agentpoc.ToolOutput, error) {
	t.Helper()
	return func(context.Context, agentpoc.ToolInput) (agentpoc.ToolOutput, error) {
		t.Fatal("tool activity was unexpectedly called")
		return agentpoc.ToolOutput{}, nil
	}
}

func assertCompleted(t *testing.T, env *testsuite.TestWorkflowEnvironment) {
	t.Helper()
	if !env.IsWorkflowCompleted() || env.GetWorkflowError() != nil {
		t.Fatalf("workflow failed: %v", env.GetWorkflowError())
	}
}
