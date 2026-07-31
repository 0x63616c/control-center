package work

// RunOutcome is the closed business outcome of a target Run.
type RunOutcome string

const (
	// RunOutcomeSucceeded records a Confirmed Merge.
	RunOutcomeSucceeded RunOutcome = "succeeded"
	// RunOutcomeCanceled records an interrupted Run whose Ticket returned to open.
	RunOutcomeCanceled RunOutcome = "canceled"
	// RunOutcomeExhausted records a Run that spent its semantic budget.
	RunOutcomeExhausted RunOutcome = "exhausted"
	// RunOutcomeFailed records unrecoverable infrastructure or input failure.
	RunOutcomeFailed RunOutcome = "failed"
)

// RunFailureKind classifies a target Run failure without making raw errors control flow.
type RunFailureKind string

const (
	RunFailureNone                   RunFailureKind = ""
	RunFailureInvalidInput           RunFailureKind = "invalid_input"
	RunFailureAgentUnrecoverable     RunFailureKind = "agent_unrecoverable"
	RunFailureAgentAttemptBudget     RunFailureKind = "agent_attempt_budget"
	RunFailureReviewBudget           RunFailureKind = "review_budget"
	RunFailureCIUnobserved           RunFailureKind = "ci_unobserved"
	RunFailureGitHubAuth             RunFailureKind = "github_auth"
	RunFailureGitHubRuleset          RunFailureKind = "github_ruleset"
	RunFailureGitHubUnavailable      RunFailureKind = "github_unavailable"
	RunFailureRunWorkerUnavailable   RunFailureKind = "run_worker_unavailable"
	RunFailurePersistenceUnavailable RunFailureKind = "persistence_unavailable"
	RunFailureInfrastructure         RunFailureKind = "infrastructure"
)

// StepKind identifies one executor-neutral target operation.
type StepKind string

const (
	StepPrepareRunWorker        StepKind = "prepare_run_worker"
	StepAcquireRunWorkerSession StepKind = "acquire_run_worker_session"
	StepCloneRepository         StepKind = "clone_repository"
	StepPlan                    StepKind = "plan"
	StepImplement               StepKind = "implement"
	StepSyncPullRequest         StepKind = "sync_pull_request"
	StepAwaitCI                 StepKind = "await_ci"
	StepReview                  StepKind = "review"
	StepMarkPullRequestReady    StepKind = "mark_pull_request_ready"
	StepMergePullRequest        StepKind = "merge_pull_request"
)

// StepState is a target Step lifecycle state.
type StepState string

const (
	StepStateRunning   StepState = "running"
	StepStateCompleted StepState = "completed"
	StepStateFailed    StepState = "failed"
)

// AgentStage is the agent-only vocabulary retained from the legacy Stage.
type AgentStage string

const (
	AgentStagePlan      AgentStage = "plan"
	AgentStageImplement AgentStage = "implement"
	AgentStageReview    AgentStage = "review"
)

// AgentAttemptState records one workflow-authorized agent execution.
type AgentAttemptState string

const (
	AgentAttemptRunning   AgentAttemptState = "running"
	AgentAttemptSucceeded AgentAttemptState = "succeeded"
	AgentAttemptFailed    AgentAttemptState = "failed"
)

// UsageState distinguishes known zero usage from unavailable usage.
type UsageState string

const (
	UsageUnknown  UsageState = "unknown"
	UsageMeasured UsageState = "measured"
)
