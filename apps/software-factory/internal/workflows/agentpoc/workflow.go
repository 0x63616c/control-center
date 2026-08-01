// Package agentpocworkflow contains the deterministic local POC orchestration.
package agentpocworkflow

import (
	"fmt"
	"time"

	base "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agentpoc"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

const (
	invalidInputErrorType = "AgentPOCInvalidInput"
	maximumAllowedTurns   = 8
	maximumToolDelay      = 15 * time.Second
)

// Workflow runs bounded model turns and schedules every side effect as an activity.
func Workflow(ctx workflow.Context, input base.Input) (base.Result, error) {
	if err := validateInput(input); err != nil {
		return base.Result{}, fmt.Errorf("validating agent POC input: %w", err)
	}

	modelContext := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 2 * time.Minute,
		HeartbeatTimeout:    15 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2,
			MaximumInterval:    10 * time.Second,
			MaximumAttempts:    3,
		},
	})
	toolContext := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		HeartbeatTimeout:    3 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2,
			MaximumAttempts:    2,
		},
	})

	request := base.ModelTurnInput{
		Model: input.Model, PromptCacheKey: input.PromptCacheKey, RequireTool: true,
		Items: []base.ConversationItem{{Kind: base.ItemUserText, Text: input.Prompt}},
	}
	result := base.Result{}
	for range input.MaxTurns {
		var turn base.ModelTurnResult
		if err := workflow.ExecuteActivity(modelContext, base.ModelTurnActivityName, request).Get(ctx, &turn); err != nil {
			return result, fmt.Errorf("running model turn %d: %w", result.ModelTurns+1, err)
		}
		result.ModelTurns++
		result.Usage = addUsage(result.Usage, turn.Usage)

		switch turn.Outcome {
		case base.OutcomeFinalText:
			if turn.Text == "" {
				return result, temporal.NewNonRetryableApplicationError(
					"the model returned an empty final answer", invalidInputErrorType, nil)
			}
			result.FinalText = turn.Text
			return result, nil
		case base.OutcomeToolCalls:
			if turn.ResponseID == "" || len(turn.ToolCalls) == 0 {
				return result, temporal.NewNonRetryableApplicationError(
					"the model returned an incomplete tool-call result", invalidInputErrorType, nil)
			}
			nextItems := append([]base.ConversationItem(nil), request.Items...)
			for _, call := range turn.ToolCalls {
				nextItems = append(nextItems, base.ConversationItem{
					Kind: base.ItemFunctionCall, ID: call.ID, CallID: call.CallID,
					Name: call.Name, Arguments: append([]byte(nil), call.Arguments...),
				})
			}
			for _, call := range turn.ToolCalls {
				var output base.ToolOutput
				if err := workflow.ExecuteActivity(toolContext, base.ToolActivityName, base.ToolInput{Call: call, Delay: input.ToolDelay}).Get(ctx, &output); err != nil {
					return result, fmt.Errorf("running allowlisted tool %q: %w", call.Name, err)
				}
				if output.CallID != call.CallID || output.Output == "" {
					return result, temporal.NewNonRetryableApplicationError(
						"the tool returned an incomplete or mismatched output", invalidInputErrorType, nil)
				}
				nextItems = append(nextItems, base.ConversationItem{
					Kind: base.ItemFunctionOutput, CallID: output.CallID, Output: output.Output,
				})
				result.ToolCalls++
			}
			request.Items = nextItems
			request.RequireTool = false
		default:
			return result, temporal.NewNonRetryableApplicationError(
				fmt.Sprintf("the model returned unknown outcome %q", turn.Outcome), invalidInputErrorType, nil)
		}
	}

	return result, temporal.NewNonRetryableApplicationError(
		base.ErrTurnLimit.Error(), base.TurnLimitErrorType, base.ErrTurnLimit)
}

func validateInput(input base.Input) error {
	if input.Prompt == "" || input.Model == "" || input.PromptCacheKey == "" {
		return temporal.NewNonRetryableApplicationError(
			"the agent POC needs a prompt, model, and prompt cache key", invalidInputErrorType, nil)
	}
	if input.MaxTurns < 1 || input.MaxTurns > maximumAllowedTurns {
		return temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("the agent POC max turns must be between 1 and %d", maximumAllowedTurns), invalidInputErrorType, nil)
	}
	if input.ToolDelay < 0 || input.ToolDelay > maximumToolDelay {
		return temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("the agent POC tool delay must be between zero and %s", maximumToolDelay), invalidInputErrorType, nil)
	}
	return nil
}

func addUsage(total, turn base.Usage) base.Usage {
	return base.Usage{
		InputTokens:  total.InputTokens + turn.InputTokens,
		OutputTokens: total.OutputTokens + turn.OutputTokens,
		TotalTokens:  total.TotalTokens + turn.TotalTokens,
	}
}
