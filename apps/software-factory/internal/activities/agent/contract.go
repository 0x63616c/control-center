package agentactivities

import (
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// PromptRenderer is the existing product-owned stage prompt and result format.
type PromptRenderer interface {
	Render(key work.StageKey, detail work.TicketDetail, prior work.PriorTurns) (prompt string, schema []byte, err error)
	Decode(stage work.Stage, result []byte) (work.StageOutput, error)
}

// PrepareInput contains the bounded parent-owned stage attempt.
type PrepareInput struct {
	Attempt  activities.StageAttempt
	CacheKey string
}

// PrepareOutput starts the reference-only workflow state.
type PrepareOutput struct {
	ConversationRef agent.ConversationRef
	TranscriptRef   agent.TranscriptRef
	ResponseFormat  agent.ResponseFormatRef
	PromptCacheKey  string
}

// FinalizeInput identifies terminal structured text and its expected stage shape.
type FinalizeInput struct {
	Stage   work.Stage
	TextRef agent.TextRef
}

// FinalizeOutput contains the decoded closed stage result.
type FinalizeOutput struct {
	Result work.StageOutput
}
