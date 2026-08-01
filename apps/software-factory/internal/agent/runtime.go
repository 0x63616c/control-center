package agent

import "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"

// ToolsetID identifies one immutable meaning of a tool catalogue.
type ToolsetID string

const (
	// ToolsetCodingReadV1 is the immutable read-only plan/review catalogue.
	ToolsetCodingReadV1 ToolsetID = "coding-read-v1"
	// ToolsetCodingWriteV1 is the immutable implement catalogue.
	ToolsetCodingWriteV1 ToolsetID = "coding-write-v1"
)

// Limits fixes one agent run's resource budgets at child-workflow start.
type Limits struct {
	MaxModelTurns        int   `json:"max_model_turns"`
	MaxToolCalls         int   `json:"max_tool_calls"`
	MaxInputTokens       int64 `json:"max_input_tokens"`
	MaxOutputTokens      int64 `json:"max_output_tokens"`
	MaxConversationBytes int64 `json:"max_conversation_bytes"`
	ContinueAsNewAfter   int   `json:"continue_as_new_after"`
}

// DefaultLimits returns the fixed V1 operational and spend bounds for one stage agent.
func DefaultLimits() Limits {
	return Limits{
		MaxModelTurns: 24, MaxToolCalls: 96, MaxInputTokens: 500_000, MaxOutputTokens: 100_000,
		MaxConversationBytes: 1 << 20, ContinueAsNewAfter: 8,
	}
}

// ModelTurnInput routes one provider turn using only bounded metadata and a conversation reference.
type ModelTurnInput struct {
	Model           work.Model        `json:"model"`
	ToolsetID       ToolsetID         `json:"toolset_id"`
	ConversationRef ConversationRef   `json:"conversation_ref"`
	TranscriptRef   TranscriptRef     `json:"transcript_ref"`
	ResponseFormat  ResponseFormatRef `json:"response_format"`
	PromptCacheKey  string            `json:"prompt_cache_key"`
	ModelTurn       int               `json:"model_turn"`
	IdempotencyKey  string            `json:"idempotency_key"`
}

// TurnOutcome distinguishes a terminal answer from requested tool calls.
type TurnOutcome string

const (
	// OutcomeFinalText means the model produced its terminal structured text.
	OutcomeFinalText TurnOutcome = "final_text"
	// OutcomeToolCalls means the model requested one or more tools.
	OutcomeToolCalls TurnOutcome = "tool_calls"
)

// ArtifactRef identifies one immutable agent artifact.
type ArtifactRef struct {
	Key    string `json:"key"`
	Bytes  int64  `json:"bytes"`
	Digest string `json:"digest"`
}

// TextRef identifies immutable final text.
type TextRef ArtifactRef

// ArgumentsRef identifies immutable tool arguments.
type ArgumentsRef ArtifactRef

// OutputRef identifies immutable oversized tool output.
type OutputRef ArtifactRef

// TranscriptRef identifies the latest immutable revision of one provider-neutral transcript.
type TranscriptRef struct {
	Key      string `json:"key"`
	Revision int    `json:"revision"`
	Bytes    int64  `json:"bytes"`
	Digest   string `json:"digest"`
}

// ResponseSchemaRef identifies one immutable provider structured-output schema.
type ResponseSchemaRef ArtifactRef

// ResponseFormatRef names the strict structured output expected from every model turn.
type ResponseFormatRef struct {
	Name      string            `json:"name"`
	SchemaRef ResponseSchemaRef `json:"schema_ref"`
}

// PendingToolCall is bounded routing metadata for one provider function call.
type PendingToolCall struct {
	CallID       string       `json:"call_id"`
	Name         string       `json:"name"`
	ArgumentsRef ArgumentsRef `json:"arguments_ref"`
}

// ToolInput routes one pending model call to the sandbox activity.
type ToolInput struct {
	ToolsetID       ToolsetID       `json:"toolset_id"`
	ConversationRef ConversationRef `json:"conversation_ref"`
	TranscriptRef   TranscriptRef   `json:"transcript_ref"`
	Call            PendingToolCall `json:"call"`
}

// ToolOutput is the bounded durable result of one sandbox tool activity.
type ToolOutput struct {
	CallID          string          `json:"call_id"`
	ConversationRef ConversationRef `json:"conversation_ref"`
	TranscriptRef   TranscriptRef   `json:"transcript_ref"`
	IsError         bool            `json:"is_error"`
}

// ModelTurnResult is the bounded durable outcome of one provider activity.
type ModelTurnResult struct {
	Outcome         TurnOutcome       `json:"outcome"`
	ConversationRef ConversationRef   `json:"conversation_ref"`
	TranscriptRef   TranscriptRef     `json:"transcript_ref"`
	FinalTextRef    TextRef           `json:"final_text_ref"`
	ToolCalls       []PendingToolCall `json:"tool_calls"`
	Usage           work.Usage        `json:"usage"`
	UsageMeasured   bool              `json:"usage_measured"`
}
