package workflows

import (
	"errors"
	"fmt"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	agentactivities "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/telemetry"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// AgentWorkflowInput starts one bounded stage agent.
type AgentWorkflowInput struct {
	Attempt    activities.StageAttempt
	ToolsetID  agent.ToolsetID
	ToolTarget agent.ToolTarget
	Limits     agent.Limits
	CacheKey   string
	State      *AgentWorkflowState
}

// AgentWorkflowState is the reference-only state carried across Continue-As-New.
type AgentWorkflowState struct {
	ConversationRef         agent.ConversationRef
	TranscriptRef           agent.TranscriptRef
	ResponseFormat          agent.ResponseFormatRef
	ToolsetFingerprint      string
	PromptCacheKey          string
	Usage                   work.Usage
	UsageMeasured           bool
	ModelTurns              int
	ToolCalls               int
	TurnsSinceContinueAsNew int
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
func AgentWorkflow(ctx workflow.Context, input AgentWorkflowInput) (workflowResult AgentWorkflowResult, workflowErr error) {
	defer func() { recordAgentLifecycle(ctx, workflowErr) }()
	if err := validateAgentInput(input); err != nil {
		return AgentWorkflowResult{}, temporal.NewNonRetryableApplicationError(err.Error(), agent.ErrorTypeInvalidInput, err)
	}
	toolTaskQueue, err := input.ToolTarget.TaskQueue(input.Attempt.Key.RunID)
	if err != nil {
		return AgentWorkflowResult{}, temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("resolve agent tool target: %v", err), agent.ErrorTypeInvalidInput, err,
		)
	}
	mainContext := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 2 * time.Minute,
		HeartbeatTimeout:    15 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval: time.Second, BackoffCoefficient: 2, MaximumInterval: 10 * time.Second, MaximumAttempts: 3,
		},
	})
	state := AgentWorkflowState{}
	if input.State == nil {
		var prepared agentactivities.PrepareOutput
		if err := workflow.ExecuteActivity(mainContext, agent.PrepareActivityName, agentactivities.PrepareInput{
			Attempt: input.Attempt, CacheKey: input.CacheKey,
		}).Get(ctx, &prepared); err != nil {
			return AgentWorkflowResult{}, fmt.Errorf("prepare agent workflow: %w", err)
		}
		state.ConversationRef = prepared.ConversationRef
		state.TranscriptRef = prepared.TranscriptRef
		state.ResponseFormat = prepared.ResponseFormat
		state.PromptCacheKey = prepared.PromptCacheKey
		state.UsageMeasured = true
	} else {
		state = *input.State
	}
	result := AgentWorkflowResult{
		Usage: state.Usage, UsageMeasured: state.UsageMeasured, TranscriptRef: state.TranscriptRef,
		ModelTurns: state.ModelTurns, ToolCalls: state.ToolCalls,
	}
	conversationRef := state.ConversationRef
	if conversationRef.Bytes > input.Limits.MaxConversationBytes {
		return result, agentBudgetError("agent conversation budget exhausted", "AgentConversationBudget")
	}
	var sessionContext workflow.Context
	for {
		if result.ModelTurns >= input.Limits.MaxModelTurns {
			return result, temporal.NewNonRetryableApplicationError("agent model-turn budget exhausted", "AgentModelTurnBudget", nil)
		}
		if state.TurnsSinceContinueAsNew >= input.Limits.ContinueAsNewAfter {
			state.ConversationRef = conversationRef
			state.TranscriptRef = result.TranscriptRef
			state.Usage = result.Usage
			state.UsageMeasured = result.UsageMeasured
			state.ModelTurns = result.ModelTurns
			state.ToolCalls = result.ToolCalls
			state.TurnsSinceContinueAsNew = 0
			return result, continueAgentWorkflowAsNew(ctx, input, state)
		}
		modelTurn := result.ModelTurns + 1
		var turn agent.ModelTurnResult
		if err := workflow.ExecuteActivity(mainContext, agent.ModelTurnActivityName, agent.ModelTurnInput{
			Model: input.Attempt.Model, ToolsetID: input.ToolsetID, ToolsetFingerprint: state.ToolsetFingerprint,
			ConversationRef: conversationRef, TranscriptRef: result.TranscriptRef,
			ResponseFormat: state.ResponseFormat, PromptCacheKey: state.PromptCacheKey, ModelTurn: modelTurn,
			IdempotencyKey: fmt.Sprintf("agent/%s/%s/%d/model/%d", input.Attempt.Key.RunID, input.Attempt.Key.Stage, input.Attempt.Key.Turn, modelTurn),
		}).Get(ctx, &turn); err != nil {
			return result, fmt.Errorf("run agent model turn %d: %w", modelTurn, err)
		}
		result.ModelTurns++
		if turn.ToolsetFingerprint == "" {
			return result, temporal.NewNonRetryableApplicationError(
				"agent model turn returned no toolset fingerprint", agent.ErrorTypeInvalidProviderOutcome, nil,
			)
		}
		if state.ToolsetFingerprint == "" {
			state.ToolsetFingerprint = turn.ToolsetFingerprint
		} else if state.ToolsetFingerprint != turn.ToolsetFingerprint {
			return result, temporal.NewNonRetryableApplicationError(
				"agent model turn changed the pinned toolset fingerprint", agent.ErrorTypeInvalidProviderOutcome, nil,
			)
		}
		state.TurnsSinceContinueAsNew++
		result.Usage = result.Usage.Add(turn.Usage)
		result.UsageMeasured = result.UsageMeasured && turn.UsageMeasured
		conversationRef = turn.ConversationRef
		if turn.TranscriptRef.Key != "" {
			result.TranscriptRef = turn.TranscriptRef
		}
		if result.UsageMeasured && result.Usage.InputTokens > input.Limits.MaxInputTokens {
			return result, agentBudgetError("agent input-token budget exhausted", "AgentInputTokenBudget")
		}
		if result.UsageMeasured && result.Usage.OutputTokens > input.Limits.MaxOutputTokens {
			return result, agentBudgetError("agent output-token budget exhausted", "AgentOutputTokenBudget")
		}
		if conversationRef.Bytes > input.Limits.MaxConversationBytes {
			return result, agentBudgetError("agent conversation budget exhausted", "AgentConversationBudget")
		}
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
				targetQueue := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
					TaskQueue: toolTaskQueue,
				})
				created, err := workflow.CreateSession(targetQueue, &workflow.SessionOptions{
					ExecutionTimeout: work.SessionExecutionTimeout,
					CreationTimeout:  work.SessionCreationTimeout,
				})
				if err != nil {
					return result, fmt.Errorf("create agent tool session on %q: %w", toolTaskQueue, err)
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
					ToolsetID: input.ToolsetID, ToolsetFingerprint: state.ToolsetFingerprint,
					ConversationRef: conversationRef, TranscriptRef: result.TranscriptRef, Call: call,
				}).Get(ctx, &toolOutput); err != nil {
					return result, fmt.Errorf("run agent tool %q: %w", call.Name, err)
				}
				if toolOutput.CallID != call.CallID {
					return result, temporal.NewNonRetryableApplicationError(
						"agent tool output call id mismatch", agent.ErrorTypeInvalidProviderOutcome, nil,
					)
				}
				conversationRef = toolOutput.ConversationRef
				if toolOutput.TranscriptRef.Key != "" {
					result.TranscriptRef = toolOutput.TranscriptRef
				}
				result.ToolCalls++
				if conversationRef.Bytes > input.Limits.MaxConversationBytes {
					return result, agentBudgetError("agent conversation budget exhausted", "AgentConversationBudget")
				}
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
			Stage: input.Attempt.Key.Stage, TextRef: turn.FinalTextRef, TranscriptRef: result.TranscriptRef,
		}).Get(ctx, &finalized); err != nil {
			return result, fmt.Errorf("finalize agent output: %w", err)
		}
		result.Result = finalized.Result
		if finalized.TranscriptRef.Key != "" {
			result.TranscriptRef = finalized.TranscriptRef
		}
		return result, nil
	}
}

func recordAgentLifecycle(ctx workflow.Context, terminalErr error) {
	input, record := agentLifecycleInput(terminalErr)
	if !record {
		return
	}
	disconnected, cancel := workflow.NewDisconnectedContext(ctx)
	defer cancel()
	disconnected = workflow.WithActivityOptions(disconnected, workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval: time.Second, BackoffCoefficient: 2, MaximumInterval: 5 * time.Second, MaximumAttempts: 3,
		},
	})
	if err := workflow.ExecuteActivity(disconnected, agent.LifecycleActivityName, input).Get(disconnected, nil); err != nil {
		workflow.GetLogger(disconnected).Error("record agent lifecycle", "error", err)
	}
}

func agentLifecycleInput(terminalErr error) (agentactivities.LifecycleInput, bool) {
	if workflow.IsContinueAsNewError(terminalErr) {
		return agentactivities.LifecycleInput{}, false
	}
	if terminalErr == nil {
		return agentactivities.LifecycleInput{Outcome: telemetry.AgentOutcomeSucceeded}, true
	}
	if temporal.IsCanceledError(terminalErr) {
		return agentactivities.LifecycleInput{Outcome: telemetry.AgentOutcomeCancelled}, true
	}
	input := agentactivities.LifecycleInput{Outcome: telemetry.AgentOutcomeFailed}
	var applicationError *temporal.ApplicationError
	if errors.As(terminalErr, &applicationError) {
		input.Budget = map[string]string{
			"AgentModelTurnBudget":    "model_turns",
			"AgentToolCallBudget":     "tool_calls",
			"AgentInputTokenBudget":   "input_tokens",
			"AgentOutputTokenBudget":  "output_tokens",
			"AgentConversationBudget": "conversation_bytes",
		}[applicationError.Type()]
	}
	return input, true
}

func continueAgentWorkflowAsNew(ctx workflow.Context, input AgentWorkflowInput, state AgentWorkflowState) error {
	return workflow.NewContinueAsNewError(ctx, AgentWorkflow, AgentWorkflowInput{
		Attempt: activities.StageAttempt{
			Key: input.Attempt.Key, Sandbox: input.Attempt.Sandbox, Model: input.Attempt.Model,
		},
		ToolsetID:  input.ToolsetID,
		ToolTarget: input.ToolTarget,
		Limits:     input.Limits,
		CacheKey:   input.CacheKey,
		State:      &state,
	})
}

func agentBudgetError(message, errorType string) error {
	return temporal.NewNonRetryableApplicationError(message, errorType, nil)
}

func validateAgentInput(input AgentWorkflowInput) error {
	if input.Attempt.Key.RunID == "" || input.Attempt.Key.Stage == "" || input.Attempt.Key.Turn < 1 ||
		input.ToolsetID == "" || input.CacheKey == "" {
		return fmt.Errorf("agent workflow identity, stage, turn, toolset, and cache key are required")
	}
	if err := input.Attempt.Model.Validate(); err != nil {
		return fmt.Errorf("validate agent workflow model: %w", err)
	}
	if _, err := input.ToolTarget.TaskQueue(input.Attempt.Key.RunID); err != nil {
		return fmt.Errorf("validate agent workflow tool target: %w", err)
	}
	if input.Limits.MaxModelTurns < 1 || input.Limits.MaxToolCalls < 0 || input.Limits.MaxInputTokens < 1 ||
		input.Limits.MaxOutputTokens < 1 || input.Limits.MaxConversationBytes < 1 || input.Limits.ContinueAsNewAfter < 1 {
		return fmt.Errorf("agent workflow limits must be positive")
	}
	if input.State != nil {
		if input.State.ModelTurns < 0 || input.State.ToolCalls < 0 || input.State.TurnsSinceContinueAsNew < 0 {
			return fmt.Errorf("agent workflow continued counters must not be negative")
		}
		if input.State.ToolsetFingerprint == "" {
			return fmt.Errorf("agent workflow continued state needs a pinned toolset fingerprint")
		}
	}
	return nil
}
