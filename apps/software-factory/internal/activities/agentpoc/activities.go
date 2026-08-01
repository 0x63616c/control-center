// Package agentpocactivities contains the POC's side-effecting boundaries.
package agentpocactivities

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"time"

	base "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agentpoc"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codexresponses"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
	agentpocprompt "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/prompts/agentpoc"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
)

const toolRejectedErrorType = "AgentPOCToolRejected"

// TurnClient is the sealed model boundary used by the model-turn activity.
type TurnClient interface {
	Turn(context.Context, codexresponses.TurnRequest, codexresponses.EmitFunc) (codexresponses.TurnResult, error)
}

// Activities contain the POC's two side-effect boundaries.
type Activities struct {
	client TurnClient
	clock  clock.Clock
}

// StreamProgress is safe heartbeat metadata. It deliberately contains no chunk text.
type StreamProgress struct {
	EventType codexresponses.EventType
	Events    int
}

// NewActivities constructs the POC activity set.
func NewActivities(client TurnClient, clk clock.Clock) (*Activities, error) {
	if client == nil {
		return nil, fmt.Errorf("agent POC activities need a turn client")
	}
	if clk == nil {
		return nil, fmt.Errorf("agent POC activities need a clock")
	}
	return &Activities{client: client, clock: clk}, nil
}

// ModelTurn runs one streamed provider turn and heartbeats content-free progress.
func (a *Activities) ModelTurn(ctx context.Context, input base.ModelTurnInput) (base.ModelTurnResult, error) {
	request, err := modelRequest(input)
	if err != nil {
		return base.ModelTurnResult{}, fmt.Errorf("building the direct Codex model request: %w", err)
	}
	events := 0
	result, err := a.client.Turn(ctx, request, func(event codexresponses.Event) {
		events++
		activity.RecordHeartbeat(ctx, StreamProgress{EventType: event.Type, Events: events})
	})
	if err != nil {
		return base.ModelTurnResult{}, fmt.Errorf("running a direct Codex model turn: %w", err)
	}
	return modelResult(result), nil
}

func modelRequest(input base.ModelTurnInput) (codexresponses.TurnRequest, error) {
	items := make([]codexresponses.InputItem, 0, len(input.Items))
	for _, item := range input.Items {
		switch item.Kind {
		case base.ItemUserText:
			items = append(items, codexresponses.UserText(item.Text))
		case base.ItemFunctionCall:
			items = append(items, codexresponses.FunctionCall(codexresponses.ToolCall{
				ID: item.ID, CallID: item.CallID, Name: item.Name, Arguments: item.Arguments,
			}))
		case base.ItemFunctionOutput:
			items = append(items, codexresponses.FunctionOutput(item.CallID, item.Output))
		default:
			return codexresponses.TurnRequest{}, fmt.Errorf("conversation item has unknown kind %q", item.Kind)
		}
	}
	toolChoice := codexresponses.ToolChoiceAuto
	if input.RequireTool {
		toolChoice = codexresponses.ToolChoiceRequired
	}
	return codexresponses.TurnRequest{
		Model: input.Model, Instructions: agentpocprompt.Instructions(), Input: items, Store: false,
		Tools: []codexresponses.Tool{{
			Name: base.PrototypeToolName, Description: "Return one deterministic fact used to prove the Temporal tool loop.",
			Parameters: agentpocprompt.ToolSchema(),
		}},
		ToolChoice: toolChoice, ParallelToolCalls: false,
		Reasoning: codexresponses.ReasoningOptions{
			Effort: codexresponses.ReasoningEffortLow, Summary: codexresponses.ReasoningSummaryAuto,
		},
		TextVerbosity: codexresponses.TextVerbosityLow, PromptCacheKey: input.PromptCacheKey,
		Include: []string{"reasoning.encrypted_content"},
	}, nil
}

func modelResult(result codexresponses.TurnResult) base.ModelTurnResult {
	toolCalls := make([]base.ToolCall, 0, len(result.ToolCalls))
	for _, call := range result.ToolCalls {
		toolCalls = append(toolCalls, base.ToolCall{
			ID: call.ID, CallID: call.CallID, Name: call.Name, Arguments: append([]byte(nil), call.Arguments...),
		})
	}
	return base.ModelTurnResult{
		Outcome: base.TurnOutcome(result.Outcome), ResponseID: result.ResponseID, Text: result.Text, ToolCalls: toolCalls,
		Usage: base.Usage{InputTokens: result.Usage.InputTokens, OutputTokens: result.Usage.OutputTokens, TotalTokens: result.Usage.TotalTokens},
	}
}

// Tool executes one strictly allowlisted prototype tool call.
func (a *Activities) Tool(ctx context.Context, input base.ToolInput) (base.ToolOutput, error) {
	if input.Call.Name != base.PrototypeToolName {
		return base.ToolOutput{}, rejectTool("tool %q is not allowlisted", input.Call.Name)
	}
	if input.Call.CallID == "" {
		return base.ToolOutput{}, rejectTool("the allowlisted tool call has no call id")
	}
	var arguments struct {
		Key string `json:"key"`
	}
	decoder := json.NewDecoder(bytes.NewReader(input.Call.Arguments))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&arguments); err != nil {
		return base.ToolOutput{}, rejectTool("the allowlisted tool arguments are invalid")
	}
	if err := ensureJSONEnd(decoder); err != nil {
		return base.ToolOutput{}, rejectTool("the allowlisted tool arguments contain trailing data")
	}
	if arguments.Key != "temporal" {
		return base.ToolOutput{}, rejectTool("the allowlisted tool does not recognize key %q", arguments.Key)
	}
	for elapsed := time.Duration(0); elapsed < input.Delay; elapsed += time.Second {
		activity.RecordHeartbeat(ctx, base.ToolProgress{Elapsed: elapsed})
		step := min(time.Second, input.Delay-elapsed)
		if err := a.clock.Sleep(ctx, step); err != nil {
			return base.ToolOutput{}, fmt.Errorf("waiting in the restart-proof tool: %w", err)
		}
	}
	return base.ToolOutput{
		CallID: input.Call.CallID,
		Output: `{"value":"Temporal durably resumes work after worker failure."}`,
	}, nil
}

func ensureJSONEnd(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("expected the end of the JSON object")
	}
	return nil
}

func rejectTool(format string, args ...any) error {
	return temporal.NewNonRetryableApplicationError(
		fmt.Sprintf(format, args...), toolRejectedErrorType, nil)
}
