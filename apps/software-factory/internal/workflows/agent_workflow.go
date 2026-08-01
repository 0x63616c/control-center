package workflows

import (
	"fmt"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	agentactivities "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// AgentWorkflowInput starts one bounded stage agent.
type AgentWorkflowInput struct {
	Attempt   activities.StageAttempt
	ToolsetID agent.ToolsetID
	Limits    agent.Limits
	CacheKey  string
}

// AgentWorkflowResult is the bounded typed result returned to FactoryWorkTicket.
type AgentWorkflowResult struct {
	Result        work.StageOutput
	Usage         work.Usage
	UsageMeasured bool
	TranscriptRef agent.TranscriptRef
	ModelTurns    int
	ToolCalls     int
}

// AgentWorkflow runs one bounded reference-only model/tool loop.
func AgentWorkflow(ctx workflow.Context, input AgentWorkflowInput) (AgentWorkflowResult, error) {
	if err := validateAgentInput(input); err != nil {
		return AgentWorkflowResult{}, temporal.NewNonRetryableApplicationError(err.Error(), agent.ErrorTypeInvalidInput, err)
	}
	mainContext := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 2 * time.Minute,
		HeartbeatTimeout:    15 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval: time.Second, BackoffCoefficient: 2, MaximumInterval: 10 * time.Second, MaximumAttempts: 3,
		},
	})
	var prepared agentactivities.PrepareOutput
	if err := workflow.ExecuteActivity(mainContext, agent.PrepareActivityName, agentactivities.PrepareInput{
		Attempt: input.Attempt, CacheKey: input.CacheKey,
	}).Get(ctx, &prepared); err != nil {
		return AgentWorkflowResult{}, fmt.Errorf("prepare agent workflow: %w", err)
	}
	result := AgentWorkflowResult{TranscriptRef: prepared.TranscriptRef, UsageMeasured: true}
	conversationRef := prepared.ConversationRef
	for modelTurn := 1; modelTurn <= input.Limits.MaxModelTurns; modelTurn++ {
		var turn agent.ModelTurnResult
		if err := workflow.ExecuteActivity(mainContext, agent.ModelTurnActivityName, agent.ModelTurnInput{
			Model: input.Attempt.Model, ToolsetID: input.ToolsetID, ConversationRef: conversationRef,
			PromptCacheKey: input.CacheKey, ModelTurn: modelTurn,
			IdempotencyKey: fmt.Sprintf("agent/%s/%s/%d/model/%d", input.Attempt.Key.RunID, input.Attempt.Key.Stage, input.Attempt.Key.Turn, modelTurn),
		}).Get(ctx, &turn); err != nil {
			return result, fmt.Errorf("run agent model turn %d: %w", modelTurn, err)
		}
		result.ModelTurns++
		result.Usage = result.Usage.Add(turn.Usage)
		result.UsageMeasured = result.UsageMeasured && turn.UsageMeasured
		conversationRef = turn.ConversationRef
		if turn.Outcome != agent.OutcomeFinalText {
			return result, temporal.NewNonRetryableApplicationError(
				fmt.Sprintf("agent model turn returned unsupported outcome %q", turn.Outcome),
				agent.ErrorTypeInvalidProviderOutcome,
				nil,
			)
		}
		var finalized agentactivities.FinalizeOutput
		if err := workflow.ExecuteActivity(mainContext, agent.FinalizeActivityName, agentactivities.FinalizeInput{
			Stage: input.Attempt.Key.Stage, TextRef: turn.FinalTextRef,
		}).Get(ctx, &finalized); err != nil {
			return result, fmt.Errorf("finalize agent output: %w", err)
		}
		result.Result = finalized.Result
		return result, nil
	}
	return result, temporal.NewNonRetryableApplicationError("agent model-turn budget exhausted", "AgentModelTurnBudget", nil)
}

func validateAgentInput(input AgentWorkflowInput) error {
	if input.Attempt.Key.RunID == "" || input.Attempt.Key.Stage == "" || input.Attempt.Key.Turn < 1 ||
		input.ToolsetID == "" || input.CacheKey == "" {
		return fmt.Errorf("agent workflow identity, stage, turn, toolset, and cache key are required")
	}
	if err := input.Attempt.Model.Validate(); err != nil {
		return err
	}
	if input.Limits.MaxModelTurns < 1 || input.Limits.MaxToolCalls < 0 || input.Limits.MaxInputTokens < 1 ||
		input.Limits.MaxOutputTokens < 1 || input.Limits.MaxConversationBytes < 1 || input.Limits.ContinueAsNewAfter < 1 {
		return fmt.Errorf("agent workflow limits must be positive")
	}
	return nil
}
