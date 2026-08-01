package workflows_test

import (
	"context"
	"errors"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	agentactivities "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/worker"
)

func TestAgentWorkflowCompletesFromOneFinalModelTurn(t *testing.T) {
	t.Parallel()

	conversationRef := agent.ConversationRef{Key: "conversations/agent/run-7/plan/0/digest", Revision: 0, Bytes: 100, Digest: "digest"}
	textRef := agent.TextRef{Key: "conversations/agent/run-7/plan/artifacts/text/final", Bytes: 18, Digest: "final"}
	expected := work.NewStageOutput(work.StagePlan, work.DocumentOutput{Document: "the plan"})
	suite := &testsuite.WorkflowTestSuite{}
	environment := suite.NewTestWorkflowEnvironment()
	environment.RegisterActivityWithOptions(
		func(context.Context, agentactivities.PrepareInput) (agentactivities.PrepareOutput, error) {
			return agentactivities.PrepareOutput{ConversationRef: conversationRef}, nil
		}, activity.RegisterOptions{Name: agent.PrepareActivityName},
	)
	environment.RegisterActivityWithOptions(
		func(_ context.Context, input agent.ModelTurnInput) (agent.ModelTurnResult, error) {
			if input.ConversationRef != conversationRef || input.ModelTurn != 1 {
				t.Fatalf("model input = %#v", input)
			}
			return agent.ModelTurnResult{
				Outcome: agent.OutcomeFinalText, ConversationRef: conversationRef, FinalTextRef: textRef,
				Usage: work.Usage{InputTokens: 10, OutputTokens: 3}, UsageMeasured: true,
			}, nil
		}, activity.RegisterOptions{Name: agent.ModelTurnActivityName},
	)
	environment.RegisterActivityWithOptions(
		func(_ context.Context, input agentactivities.FinalizeInput) (agentactivities.FinalizeOutput, error) {
			if input.Stage != work.StagePlan || input.TextRef != textRef {
				t.Fatalf("finalize input = %#v", input)
			}
			return agentactivities.FinalizeOutput{Result: expected}, nil
		}, activity.RegisterOptions{Name: agent.FinalizeActivityName},
	)
	input := workflows.AgentWorkflowInput{
		Attempt: activities.StageAttempt{
			Key:     work.StageKey{Ticket: 7, RunID: "run-7", Stage: work.StagePlan, Turn: 1},
			Sandbox: "sandbox-7", Model: work.Model{Name: "gpt-test", Effort: "medium"},
		},
		ToolsetID: "coding-read-v1", CacheKey: "run-7-plan",
		Limits: agent.Limits{MaxModelTurns: 3, MaxToolCalls: 4, MaxInputTokens: 1000, MaxOutputTokens: 1000, MaxConversationBytes: 1 << 20, ContinueAsNewAfter: 20},
	}
	environment.ExecuteWorkflow(workflows.AgentWorkflow, input)
	if err := environment.GetWorkflowError(); err != nil {
		t.Fatalf("AgentWorkflow error = %v", err)
	}
	var result workflows.AgentWorkflowResult
	if err := environment.GetWorkflowResult(&result); err != nil {
		t.Fatalf("GetWorkflowResult() error = %v", err)
	}
	if result.Result.Prose() != "the plan" || result.ModelTurns != 1 || result.ToolCalls != 0 ||
		result.Usage.InputTokens != 10 || !result.UsageMeasured {
		t.Fatalf("AgentWorkflow result = %#v", result)
	}
}

func TestAgentWorkflowRequestsCancellationOfTheActiveTool(t *testing.T) {
	t.Parallel()

	suite := &testsuite.WorkflowTestSuite{}
	environment := suite.NewTestWorkflowEnvironment()
	environment.SetWorkerOptions(worker.Options{EnableSessionWorker: true, MaxConcurrentSessionExecutionSize: 1})
	environment.RegisterActivityWithOptions(func(context.Context, agentactivities.PrepareInput) (agentactivities.PrepareOutput, error) {
		return agentactivities.PrepareOutput{ConversationRef: agent.ConversationRef{Revision: 0, Bytes: 50}}, nil
	}, activity.RegisterOptions{Name: agent.PrepareActivityName})
	environment.RegisterActivityWithOptions(func(context.Context, agent.ModelTurnInput) (agent.ModelTurnResult, error) {
		return agent.ModelTurnResult{
			Outcome: agent.OutcomeToolCalls, ConversationRef: agent.ConversationRef{Revision: 1, Bytes: 100},
			ToolCalls: []agent.PendingToolCall{{CallID: "call_slow", Name: "exec_command"}}, UsageMeasured: true,
		}, nil
	}, activity.RegisterOptions{Name: agent.ModelTurnActivityName})
	toolCancelled := false
	environment.SetOnActivityCanceledListener(func(info *activity.Info) {
		if info.ActivityType.Name == agent.ToolActivityName {
			toolCancelled = true
		}
	})
	environment.RegisterActivityWithOptions(func(ctx context.Context, _ agent.ToolInput) (agent.ToolOutput, error) {
		environment.CancelWorkflow()
		<-ctx.Done()
		return agent.ToolOutput{}, ctx.Err()
	}, activity.RegisterOptions{Name: agent.ToolActivityName})
	environment.ExecuteWorkflow(workflows.AgentWorkflow, validAgentWorkflowInput(work.StageImplement))
	if !toolCancelled {
		t.Fatal("active tool activity did not observe cancellation")
	}
	if !temporal.IsCanceledError(environment.GetWorkflowError()) {
		t.Fatalf("workflow error = %v, want cancellation", environment.GetWorkflowError())
	}
}

func TestAgentWorkflowStopsAtModelToolAndTokenBudgets(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		limits    agent.Limits
		turn      agent.ModelTurnResult
		wantType  string
		wantTools int
	}{
		{name: "model turns", limits: agent.Limits{MaxModelTurns: 1, MaxToolCalls: 2, MaxInputTokens: 100, MaxOutputTokens: 100, MaxConversationBytes: 1000, ContinueAsNewAfter: 20},
			turn: agent.ModelTurnResult{Outcome: agent.OutcomeToolCalls, ConversationRef: agent.ConversationRef{Revision: 1, Bytes: 100}, ToolCalls: []agent.PendingToolCall{{CallID: "call_1", Name: "read_file"}}, UsageMeasured: true}, wantType: "AgentModelTurnBudget", wantTools: 1},
		{name: "tool calls", limits: agent.Limits{MaxModelTurns: 2, MaxToolCalls: 0, MaxInputTokens: 100, MaxOutputTokens: 100, MaxConversationBytes: 1000, ContinueAsNewAfter: 20},
			turn: agent.ModelTurnResult{Outcome: agent.OutcomeToolCalls, ConversationRef: agent.ConversationRef{Revision: 1, Bytes: 100}, ToolCalls: []agent.PendingToolCall{{CallID: "call_1", Name: "read_file"}}, UsageMeasured: true}, wantType: "AgentToolCallBudget"},
		{name: "input tokens", limits: agent.Limits{MaxModelTurns: 2, MaxToolCalls: 2, MaxInputTokens: 9, MaxOutputTokens: 100, MaxConversationBytes: 1000, ContinueAsNewAfter: 20},
			turn: agent.ModelTurnResult{Outcome: agent.OutcomeFinalText, ConversationRef: agent.ConversationRef{Revision: 1, Bytes: 100}, FinalTextRef: agent.TextRef{Key: "text"}, Usage: work.Usage{InputTokens: 10}, UsageMeasured: true}, wantType: "AgentInputTokenBudget"},
		{name: "output tokens", limits: agent.Limits{MaxModelTurns: 2, MaxToolCalls: 2, MaxInputTokens: 100, MaxOutputTokens: 9, MaxConversationBytes: 1000, ContinueAsNewAfter: 20},
			turn: agent.ModelTurnResult{Outcome: agent.OutcomeFinalText, ConversationRef: agent.ConversationRef{Revision: 1, Bytes: 100}, FinalTextRef: agent.TextRef{Key: "text"}, Usage: work.Usage{OutputTokens: 10}, UsageMeasured: true}, wantType: "AgentOutputTokenBudget"},
		{name: "conversation bytes", limits: agent.Limits{MaxModelTurns: 2, MaxToolCalls: 2, MaxInputTokens: 100, MaxOutputTokens: 100, MaxConversationBytes: 99, ContinueAsNewAfter: 20},
			turn: agent.ModelTurnResult{Outcome: agent.OutcomeFinalText, ConversationRef: agent.ConversationRef{Revision: 1, Bytes: 100}, FinalTextRef: agent.TextRef{Key: "text"}, UsageMeasured: true}, wantType: "AgentConversationBudget"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			suite := &testsuite.WorkflowTestSuite{}
			environment := suite.NewTestWorkflowEnvironment()
			environment.SetWorkerOptions(worker.Options{EnableSessionWorker: true, MaxConcurrentSessionExecutionSize: 1})
			environment.RegisterActivityWithOptions(func(context.Context, agentactivities.PrepareInput) (agentactivities.PrepareOutput, error) {
				return agentactivities.PrepareOutput{ConversationRef: agent.ConversationRef{Revision: 0, Bytes: 50}}, nil
			}, activity.RegisterOptions{Name: agent.PrepareActivityName})
			environment.RegisterActivityWithOptions(func(context.Context, agent.ModelTurnInput) (agent.ModelTurnResult, error) {
				return test.turn, nil
			}, activity.RegisterOptions{Name: agent.ModelTurnActivityName})
			tools := 0
			environment.RegisterActivityWithOptions(func(_ context.Context, input agent.ToolInput) (agent.ToolOutput, error) {
				tools++
				return agent.ToolOutput{CallID: input.Call.CallID, ConversationRef: agent.ConversationRef{Revision: 2, Bytes: 100}}, nil
			}, activity.RegisterOptions{Name: agent.ToolActivityName})
			environment.RegisterActivityWithOptions(func(context.Context, agentactivities.FinalizeInput) (agentactivities.FinalizeOutput, error) {
				t.Fatal("finalize activity must not run after a budget is exhausted")
				return agentactivities.FinalizeOutput{}, nil
			}, activity.RegisterOptions{Name: agent.FinalizeActivityName})
			input := validAgentWorkflowInput(work.StageImplement)
			input.Limits = test.limits
			environment.ExecuteWorkflow(workflows.AgentWorkflow, input)
			var applicationError *temporal.ApplicationError
			if !errors.As(environment.GetWorkflowError(), &applicationError) || applicationError.Type() != test.wantType || !applicationError.NonRetryable() {
				t.Fatalf("workflow error = %v, want non-retryable %q", environment.GetWorkflowError(), test.wantType)
			}
			if tools != test.wantTools {
				t.Fatalf("tool calls = %d, want %d", tools, test.wantTools)
			}
		})
	}
}

func TestAgentWorkflowExecutesARequestedToolAndContinuesWithItsOutput(t *testing.T) {
	t.Parallel()

	initial := agent.ConversationRef{Key: "conversations/agent/run-7/implement/1/0/initial", Revision: 0, Bytes: 100, Digest: "initial"}
	requested := agent.ConversationRef{Key: "conversations/agent/run-7/implement/1/1/requested", Revision: 1, Bytes: 100, Digest: "requested"}
	continued := agent.ConversationRef{Key: "conversations/agent/run-7/implement/1/2/continued", Revision: 2, Bytes: 100, Digest: "continued"}
	argumentsRef := agent.ArgumentsRef{Key: "conversations/args", Bytes: 10, Digest: "args"}
	textRef := agent.TextRef{Key: "conversations/text", Bytes: 10, Digest: "text"}
	suite := &testsuite.WorkflowTestSuite{}
	environment := suite.NewTestWorkflowEnvironment()
	environment.SetWorkerOptions(worker.Options{EnableSessionWorker: true, MaxConcurrentSessionExecutionSize: 1})
	environment.RegisterActivityWithOptions(
		func(context.Context, agentactivities.PrepareInput) (agentactivities.PrepareOutput, error) {
			return agentactivities.PrepareOutput{ConversationRef: initial}, nil
		}, activity.RegisterOptions{Name: agent.PrepareActivityName},
	)
	modelTurns := 0
	environment.RegisterActivityWithOptions(
		func(_ context.Context, input agent.ModelTurnInput) (agent.ModelTurnResult, error) {
			modelTurns++
			if modelTurns == 1 {
				return agent.ModelTurnResult{
					Outcome: agent.OutcomeToolCalls, ConversationRef: requested,
					ToolCalls:     []agent.PendingToolCall{{CallID: "call_1", Name: "read_file", ArgumentsRef: argumentsRef}},
					UsageMeasured: true,
				}, nil
			}
			if input.ConversationRef != continued {
				t.Fatalf("continuation conversation = %#v", input.ConversationRef)
			}
			return agent.ModelTurnResult{Outcome: agent.OutcomeFinalText, ConversationRef: continued, FinalTextRef: textRef, UsageMeasured: true}, nil
		}, activity.RegisterOptions{Name: agent.ModelTurnActivityName},
	)
	toolCalls := 0
	environment.RegisterActivityWithOptions(
		func(_ context.Context, input agent.ToolInput) (agent.ToolOutput, error) {
			toolCalls++
			if input.ConversationRef != requested || input.Call.CallID != "call_1" {
				t.Fatalf("tool input = %#v", input)
			}
			return agent.ToolOutput{CallID: "call_1", ConversationRef: continued}, nil
		}, activity.RegisterOptions{Name: agent.ToolActivityName},
	)
	environment.RegisterActivityWithOptions(
		func(context.Context, agentactivities.FinalizeInput) (agentactivities.FinalizeOutput, error) {
			return agentactivities.FinalizeOutput{Result: work.NewStageOutput(work.StageImplement, work.ImplementOutput{Report: "done"})}, nil
		}, activity.RegisterOptions{Name: agent.FinalizeActivityName},
	)
	input := validAgentWorkflowInput(work.StageImplement)
	environment.ExecuteWorkflow(workflows.AgentWorkflow, input)
	if err := environment.GetWorkflowError(); err != nil {
		t.Fatalf("AgentWorkflow error = %v", err)
	}
	var result workflows.AgentWorkflowResult
	if err := environment.GetWorkflowResult(&result); err != nil {
		t.Fatalf("GetWorkflowResult() error = %v", err)
	}
	if modelTurns != 2 || toolCalls != 1 || result.ModelTurns != 2 || result.ToolCalls != 1 || result.Result.Prose() != "done" {
		t.Fatalf("turns model=%d tool=%d result=%#v", modelTurns, toolCalls, result)
	}
}

func validAgentWorkflowInput(stage work.Stage) workflows.AgentWorkflowInput {
	return workflows.AgentWorkflowInput{
		Attempt: activities.StageAttempt{
			Key:     work.StageKey{Ticket: 7, RunID: "run-7", Stage: stage, Turn: 1},
			Sandbox: "sandbox-7", Model: work.Model{Name: "gpt-test", Effort: "medium"},
		},
		ToolsetID: "coding-write-v1", CacheKey: "run-7-stage",
		Limits: agent.Limits{MaxModelTurns: 3, MaxToolCalls: 4, MaxInputTokens: 1000, MaxOutputTokens: 1000, MaxConversationBytes: 1 << 20, ContinueAsNewAfter: 20},
	}
}
