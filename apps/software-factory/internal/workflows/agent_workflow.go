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
	var sessionContext workflow.Context
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
		switch turn.Outcome {
		case agent.OutcomeToolCalls:
			if len(turn.ToolCalls) == 0 {
				return result, temporal.NewNonRetryableApplicationError(
					"agent tool-call turn contained no calls", agent.ErrorTypeInvalidProviderOutcome, nil,
				)
			}
			if result.ToolCalls+len(turn.ToolCalls) > input.Limits.MaxToolCalls {
				return result, temporal.NewNonRetryableApplicationError(
					"agent tool-call budget exhausted", "AgentToolCallBudget", nil,
				)
			}
			if sessionContext == nil {
				sandboxQueue := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
					TaskQueue: work.SandboxTaskQueue(input.Attempt.Key.RunID),
				})
				created, err := workflow.CreateSession(sandboxQueue, &workflow.SessionOptions{
					ExecutionTimeout: work.SessionExecutionTimeout,
					CreationTimeout:  work.SessionCreationTimeout,
				})
				if err != nil {
					return result, fmt.Errorf("create agent sandbox session: %w", err)
				}
				sessionContext = created
				defer workflow.CompleteSession(sessionContext)
			}
			toolContext := workflow.WithActivityOptions(sessionContext, workflow.ActivityOptions{
				StartToCloseTimeout: 2 * time.Minute,
				HeartbeatTimeout:    15 * time.Second,
				WaitForCancellation: true,
				RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 2},
			})
			for _, call := range turn.ToolCalls {
				var toolOutput agent.ToolOutput
				if err := workflow.ExecuteActivity(toolContext, agent.ToolActivityName, agent.ToolInput{
					ToolsetID: input.ToolsetID, ConversationRef: conversationRef, Call: call,
				}).Get(ctx, &toolOutput); err != nil {
					return result, fmt.Errorf("run agent tool %q: %w", call.Name, err)
				}
				if toolOutput.CallID != call.CallID {
					return result, temporal.NewNonRetryableApplicationError(
						"agent tool output call id mismatch", agent.ErrorTypeInvalidProviderOutcome, nil,
					)
				}
				conversationRef = toolOutput.ConversationRef
				result.ToolCalls++
			}
			continue
		case agent.OutcomeFinalText:
		default:
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
