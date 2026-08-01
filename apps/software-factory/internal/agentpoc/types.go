package agentpoc

import (
	"errors"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codexresponses"
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
	Usage      codexresponses.Usage
}

// ModelTurnInput is the provider-neutral request persisted for one activity.
type ModelTurnInput struct {
	Request codexresponses.TurnRequest
}

// ToolInput asks the allowlist to execute one complete provider tool call.
type ToolInput struct {
	Call  codexresponses.ToolCall
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
