package agent

const (
	// WorkflowName is the stable Temporal registration for the reusable agent runtime.
	WorkflowName = "AgentWorkflow"
	// PrepareActivityName is the prompt and initial-conversation activity.
	PrepareActivityName = "agent.prepare"
	// ModelTurnActivityName is one direct provider turn.
	ModelTurnActivityName = "agent.model-turn"
	// ToolActivityName is one sandbox-affine typed tool execution.
	ToolActivityName = "agent.tool"
	// FinalizeActivityName decodes terminal structured text into a stage result.
	FinalizeActivityName = "agent.finalize"
	// PersistTranscriptActivityName stores one finalized transcript ref against its recorded Attempt.
	PersistTranscriptActivityName = "agent.persist-transcript"
)
