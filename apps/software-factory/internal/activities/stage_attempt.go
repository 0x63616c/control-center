package activities

import "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"

// StageAttempt is the semantic input passed to AgentWorkflow.
type StageAttempt struct {
	Key           work.StageKey
	Model         work.Model
	Detail        work.TicketDetail
	Prior         work.PriorTurns
	PromptContext work.AgentPromptContext
	// LegacyMaxReviewSteps reproduces prompt commands for histories created
	// before review limits were removed. New executions leave it zero.
	LegacyMaxReviewSteps int `json:"MaxReviewSteps,omitempty"`
}
