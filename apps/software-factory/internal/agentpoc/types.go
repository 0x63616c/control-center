package agentpoc

import (
	"errors"
	"time"
)

const (
	// TaskQueue is polled only by the local POC worker.
	TaskQueue = "codex-agent-poc"
	// WorkflowName is the stable Temporal registration for the POC workflow.
	WorkflowName = "AgentPOCWorkflow"
	// ModelTurnActivityName is the durable boundary around one provider turn.
	ModelTurnActivityName = "agent-poc.model-turn"
	// ToolActivityName is the durable boundary around one allowlisted tool call.
	ToolActivityName = "agent-poc.tool"
	// PrototypeToolName is the one harmless tool available to the POC model.
	PrototypeToolName = "lookup_prototype_fact"
	// TurnLimitErrorType identifies the workflow's non-retryable budget failure.
	TurnLimitErrorType = "AgentPOCTurnLimit"
)

// ErrTurnLimit means the agent asked for another model turn after its budget.
var ErrTurnLimit = errors.New("agent turn limit reached")

// TurnOutcome distinguishes a final answer from an activity request.
type TurnOutcome string

const (
	// OutcomeFinalText means the agent finished with user-facing text.
	OutcomeFinalText TurnOutcome = "final_text"
	// OutcomeToolCalls means the agent requested one or more tools.
	OutcomeToolCalls TurnOutcome = "tool_calls"
)

// Usage is the compact token accounting retained in workflow history.
type Usage struct {
	InputTokens  int64
	OutputTokens int64
	TotalTokens  int64
}

// ToolCall is one complete, provider-neutral function request.
type ToolCall struct {
	ID        string
	CallID    string
	Name      string
	Arguments []byte
}

// ConversationItemKind identifies the wire-neutral item shape.
type ConversationItemKind string

const (
	// ItemUserText is the user's original request.
	ItemUserText ConversationItemKind = "user_text"
	// ItemFunctionCall is the model's durable function request.
	ItemFunctionCall ConversationItemKind = "function_call"
	// ItemFunctionOutput is the matching allowlisted tool result.
	ItemFunctionOutput ConversationItemKind = "function_output"
)

// ConversationItem is one compact item replayed on a stateless continuation.
type ConversationItem struct {
	Kind      ConversationItemKind
	Text      string
	ID        string
	CallID    string
	Name      string
	Arguments []byte
	Output    string
}

// Input starts one bounded agent workflow.
type Input struct {
	Prompt         string
	Model          string
	MaxTurns       int
	PromptCacheKey string
	ToolDelay      time.Duration
}

// Result is the compact durable outcome; stream chunks and transcripts stay out.
type Result struct {
	FinalText  string
	ModelTurns int
	ToolCalls  int
	Usage      Usage
}

// ModelTurnInput is the provider-neutral request persisted for one activity.
type ModelTurnInput struct {
	Model          string
	PromptCacheKey string
	Items          []ConversationItem
	RequireTool    bool
}

// ModelTurnResult is the provider-neutral result persisted by the workflow.
type ModelTurnResult struct {
	Outcome    TurnOutcome
	ResponseID string
	Text       string
	ToolCalls  []ToolCall
	Usage      Usage
}

// ToolInput asks the allowlist to execute one complete provider tool call.
type ToolInput struct {
	Call  ToolCall
	Delay time.Duration
}

// ToolOutput returns a compact result to the matching provider call.
type ToolOutput struct {
	CallID string
	Output string
}

// ToolProgress is content-free heartbeat metadata for the restart proof.
type ToolProgress struct {
	Elapsed time.Duration
}
