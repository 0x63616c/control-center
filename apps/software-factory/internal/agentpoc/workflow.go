package agentpoc

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codexresponses"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

const (
	invalidInputErrorType = "AgentPOCInvalidInput"
	maximumAllowedTurns   = 8
)

var prototypeToolParameters = json.RawMessage(
	`{"type":"object","properties":{"key":{"type":"string","enum":["temporal"]}},"required":["key"],"additionalProperties":false}`,
)

// Workflow runs bounded model turns and schedules every side effect as an activity.
func Workflow(ctx workflow.Context, input Input) (Result, error) {
	if err := validateInput(input); err != nil {
		return Result{}, err
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
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2,
			MaximumAttempts:    2,
		},
	})

	request := initialRequest(input)
	result := Result{}
	for range input.MaxTurns {
		var turn codexresponses.TurnResult
		if err := workflow.ExecuteActivity(modelContext, ModelTurnActivityName, ModelTurnInput{Request: request}).Get(ctx, &turn); err != nil {
			return result, err
		}
		result.ModelTurns++
		result.Usage = addUsage(result.Usage, turn.Usage)

		switch turn.Outcome {
		case codexresponses.OutcomeFinalText:
			if turn.Text == "" {
				return result, temporal.NewNonRetryableApplicationError(
					"the model returned an empty final answer", invalidInputErrorType, nil)
			}
			result.FinalText = turn.Text
			return result, nil
		case codexresponses.OutcomeToolCalls:
			if turn.ResponseID == "" || len(turn.ToolCalls) == 0 {
				return result, temporal.NewNonRetryableApplicationError(
					"the model returned an incomplete tool-call result", invalidInputErrorType, nil)
			}
			outputs := make([]codexresponses.InputItem, 0, len(turn.ToolCalls))
			for _, call := range turn.ToolCalls {
				var output ToolOutput
				if err := workflow.ExecuteActivity(toolContext, ToolActivityName, ToolInput{Call: call}).Get(ctx, &output); err != nil {
					return result, err
				}
				if output.CallID != call.CallID || output.Output == "" {
					return result, temporal.NewNonRetryableApplicationError(
						"the tool returned an incomplete or mismatched output", invalidInputErrorType, nil)
				}
				outputs = append(outputs, codexresponses.FunctionOutput(output.CallID, output.Output))
				result.ToolCalls++
			}
			request.Input = outputs
			request.PreviousResponseID = turn.ResponseID
			request.ToolChoice = codexresponses.ToolChoiceAuto
		default:
			return result, temporal.NewNonRetryableApplicationError(
				fmt.Sprintf("the model returned unknown outcome %q", turn.Outcome), invalidInputErrorType, nil)
		}
	}

	return result, temporal.NewNonRetryableApplicationError(
		ErrTurnLimit.Error(), TurnLimitErrorType, ErrTurnLimit)
}

func validateInput(input Input) error {
	if input.Prompt == "" || input.Model == "" || input.PromptCacheKey == "" {
		return temporal.NewNonRetryableApplicationError(
			"the agent POC needs a prompt, model, and prompt cache key", invalidInputErrorType, nil)
	}
	if input.MaxTurns < 1 || input.MaxTurns > maximumAllowedTurns {
		return temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("the agent POC max turns must be between 1 and %d", maximumAllowedTurns), invalidInputErrorType, nil)
	}
	return nil
}

func initialRequest(input Input) codexresponses.TurnRequest {
	return codexresponses.TurnRequest{
		Model: input.Model,
		Instructions: "You are proving a Temporal-backed agent loop. You must first call the provided tool with key temporal, " +
			"then answer the user using its exact result. Do not invent a tool result.",
		Input: []codexresponses.InputItem{codexresponses.UserText(input.Prompt)},
		Store: true,
		Tools: []codexresponses.Tool{{
			Name:        PrototypeToolName,
			Description: "Return one deterministic fact used to prove the Temporal tool loop.",
			Parameters:  prototypeToolParameters,
		}},
		ToolChoice:        codexresponses.ToolChoiceRequired,
		ParallelToolCalls: false,
		Reasoning: codexresponses.ReasoningOptions{
			Effort:  codexresponses.ReasoningEffortLow,
			Summary: codexresponses.ReasoningSummaryAuto,
		},
		TextVerbosity:  codexresponses.TextVerbosityLow,
		PromptCacheKey: input.PromptCacheKey,
	}
}

func addUsage(total, turn codexresponses.Usage) codexresponses.Usage {
	return codexresponses.Usage{
		InputTokens:  total.InputTokens + turn.InputTokens,
		OutputTokens: total.OutputTokens + turn.OutputTokens,
		TotalTokens:  total.TotalTokens + turn.TotalTokens,
	}
}
