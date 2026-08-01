package agentpoc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codexresponses"
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
}

// StreamProgress is safe heartbeat metadata. It deliberately contains no chunk text.
type StreamProgress struct {
	EventType codexresponses.EventType
	Events    int
}

// NewActivities constructs the POC activity set.
func NewActivities(client TurnClient) (*Activities, error) {
	if client == nil {
		return nil, fmt.Errorf("agent POC activities need a turn client")
	}
	return &Activities{client: client}, nil
}

// ModelTurn runs one streamed provider turn and heartbeats content-free progress.
func (a *Activities) ModelTurn(ctx context.Context, input ModelTurnInput) (codexresponses.TurnResult, error) {
	events := 0
	result, err := a.client.Turn(ctx, input.Request, func(event codexresponses.Event) {
		events++
		activity.RecordHeartbeat(ctx, StreamProgress{EventType: event.Type, Events: events})
	})
	if err != nil {
		return codexresponses.TurnResult{}, fmt.Errorf("running a direct Codex model turn: %w", err)
	}
	return result, nil
}

// Tool executes one strictly allowlisted prototype tool call.
func (a *Activities) Tool(_ context.Context, input ToolInput) (ToolOutput, error) {
	if input.Call.Name != PrototypeToolName {
		return ToolOutput{}, rejectTool("tool %q is not allowlisted", input.Call.Name)
	}
	if input.Call.CallID == "" {
		return ToolOutput{}, rejectTool("the allowlisted tool call has no call id")
	}
	var arguments struct {
		Key string `json:"key"`
	}
	decoder := json.NewDecoder(bytes.NewReader(input.Call.Arguments))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&arguments); err != nil {
		return ToolOutput{}, rejectTool("the allowlisted tool arguments are invalid")
	}
	if err := ensureJSONEnd(decoder); err != nil {
		return ToolOutput{}, rejectTool("the allowlisted tool arguments contain trailing data")
	}
	if arguments.Key != "temporal" {
		return ToolOutput{}, rejectTool("the allowlisted tool does not recognize key %q", arguments.Key)
	}
	return ToolOutput{
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
