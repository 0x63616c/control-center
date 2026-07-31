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
	// RunFailureNone records a terminal outcome without a failure classification.
	RunFailureNone RunFailureKind = ""
	// RunFailureInvalidInput records an invalid target Run input.
	RunFailureInvalidInput RunFailureKind = "invalid_input"
	// RunFailureAgentUnrecoverable records an agent execution that cannot resume.
	RunFailureAgentUnrecoverable RunFailureKind = "agent_unrecoverable"
	// RunFailureAgentAttemptBudget records exhaustion of the Agent Attempt budget.
	RunFailureAgentAttemptBudget RunFailureKind = "agent_attempt_budget"
	// RunFailureReviewBudget records exhaustion of the Review Step budget.
	RunFailureReviewBudget RunFailureKind = "review_budget"
	// RunFailureCIUnobserved records an unresolved CI observation deadline.
	RunFailureCIUnobserved RunFailureKind = "ci_unobserved"
	// RunFailureGitHubAuth records an unrecoverable GitHub authentication failure.
	RunFailureGitHubAuth RunFailureKind = "github_auth"
	// RunFailureGitHubRuleset records a GitHub ruleset rejection.
	RunFailureGitHubRuleset RunFailureKind = "github_ruleset"
	// RunFailureGitHubUnavailable records an exhausted GitHub availability retry.
	RunFailureGitHubUnavailable RunFailureKind = "github_unavailable"
	// RunFailureRunWorkerUnavailable records unavailable Run Worker capacity.
	RunFailureRunWorkerUnavailable RunFailureKind = "run_worker_unavailable"
	// RunFailurePersistenceUnavailable records exhausted durable recording retries.
	RunFailurePersistenceUnavailable RunFailureKind = "persistence_unavailable"
	// RunFailureInfrastructure records another classified infrastructure failure.
	RunFailureInfrastructure RunFailureKind = "infrastructure"
)

// StepKind identifies one executor-neutral target operation.
type StepKind string

const (
	// StepPrepareRunWorker creates the Run's execution worker.
	StepPrepareRunWorker StepKind = "prepare_run_worker"
	// StepAcquireRunWorkerSession creates the worker-affine Temporal Session.
	StepAcquireRunWorkerSession StepKind = "acquire_run_worker_session"
	// StepCloneRepository clones the Run-owned repository workspace.
	StepCloneRepository StepKind = "clone_repository"
	// StepPlan performs the agent planning operation.
	StepPlan StepKind = "plan"
	// StepImplement performs one agent implementation operation.
	StepImplement StepKind = "implement"
	// StepSyncPullRequest synchronizes authoritative GitHub PR state.
	StepSyncPullRequest StepKind = "sync_pull_request"
	// StepAwaitCI observes configured checks for one exact head.
	StepAwaitCI StepKind = "await_ci"
	// StepReview performs an independent agent review.
	StepReview StepKind = "review"
	// StepMarkPullRequestReady removes draft state without requesting review.
	StepMarkPullRequestReady StepKind = "mark_pull_request_ready"
	// StepMergePullRequest asks GitHub to merge an authorized head.
	StepMergePullRequest StepKind = "merge_pull_request"
)

// StepState is a target Step lifecycle state.
type StepState string

const (
	// StepStateRunning records an active primary operation.
	StepStateRunning StepState = "running"
	// StepStateCompleted records a Step with an authoritative Result.
	StepStateCompleted StepState = "completed"
	// StepStateFailed records exhausted or non-retryable execution failure.
	StepStateFailed StepState = "failed"
)

// AgentStage is the agent-only vocabulary retained from the legacy Stage.
type AgentStage string

const (
	// AgentStagePlan is the planning agent role.
	AgentStagePlan AgentStage = "plan"
	// AgentStageImplement is the code-changing agent role.
	AgentStageImplement AgentStage = "implement"
	// AgentStageReview is the independent reviewer role.
	AgentStageReview AgentStage = "review"
)

// AgentAttemptState records one workflow-authorized agent execution.
type AgentAttemptState string

const (
	// AgentAttemptRunning records an authorized execution in progress.
	AgentAttemptRunning AgentAttemptState = "running"
	// AgentAttemptSucceeded records an agent execution that reached terminal success.
	AgentAttemptSucceeded AgentAttemptState = "succeeded"
	// AgentAttemptFailed records an agent execution that cannot continue.
	AgentAttemptFailed AgentAttemptState = "failed"
)

// UsageState distinguishes known zero usage from unavailable usage.
type UsageState string

const (
	// UsageUnknown records unavailable provider usage rather than zero spend.
	UsageUnknown UsageState = "unknown"
	// UsageMeasured records usage captured from the provider terminal envelope.
	UsageMeasured UsageState = "measured"
)
