package workflows_test

import (
	"context"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	agentactivities "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"
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
