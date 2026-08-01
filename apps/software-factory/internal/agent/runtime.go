package agent

import "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"

// ToolsetID identifies one immutable meaning of a tool catalogue.
type ToolsetID string

// Limits fixes one agent run's resource budgets at child-workflow start.
type Limits struct {
	MaxModelTurns        int   `json:"max_model_turns"`
	MaxToolCalls         int   `json:"max_tool_calls"`
	MaxInputTokens       int64 `json:"max_input_tokens"`
	MaxOutputTokens      int64 `json:"max_output_tokens"`
	MaxConversationBytes int64 `json:"max_conversation_bytes"`
	ContinueAsNewAfter   int   `json:"continue_as_new_after"`
}

// ModelTurnInput routes one provider turn using only bounded metadata and a conversation reference.
type ModelTurnInput struct {
	Model           work.Model      `json:"model"`
	ToolsetID       ToolsetID       `json:"toolset_id"`
	ConversationRef ConversationRef `json:"conversation_ref"`
	PromptCacheKey  string          `json:"prompt_cache_key"`
	ModelTurn       int             `json:"model_turn"`
	IdempotencyKey  string          `json:"idempotency_key"`
}
