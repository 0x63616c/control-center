package workflows

import (
	"fmt"
	"strings"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

const credentialRenewalInterval = 30 * time.Minute

// targetRecordingActs, runWorkerControlActs, and targetRunWorkerActs name the
// target activity boundaries. Temporal resolves their registered method names;
// workflow code never invokes the nil receivers directly.
var (
	targetRecordingActs  *activities.TargetRecordingActivities
	runWorkerControlActs *activities.RunWorkerControlActivities
	targetRunWorkerActs  *activities.RunWorkerActivities
)

// WorkOnTicketInput is the immutable admission policy and repository source
// for one target Ticket workflow.
type WorkOnTicketInput struct {
	TicketID store.TicketID
	RunID    string
	Policy   work.TargetRunPolicy
	CloneURL string
	Model    work.Model
}

// WorkOnTicket claims one Ticket before creating generation one, creates its
// private Run Worker Session, and clones the repository as that Session's
// first repository-affine activity.
func WorkOnTicket(ctx workflow.Context, in WorkOnTicketInput) error {
	if in.RunID == "" {
		// The dispatcher cannot know a child execution's Temporal Run ID until
		// after admission. Let the child bind its own immutable Store identity.
		in.RunID = workflow.GetInfo(ctx).WorkflowExecution.RunID
	}
	if err := validateWorkOnTicket(in); err != nil {
		return err
	}
	identity, err := work.NewRunWorkerIdentity(in.RunID, 1)
	if err != nil {
		return temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("the target Run %q cannot own a Run Worker: %v", in.RunID, err),
			activities.ErrTypeInvalid,
			nil,
		)
	}

	claimCtx := workflow.WithActivityOptions(ctx, targetActivityOptions(in.Policy.Recording))
	var claimed store.ClaimRunResult
	if err := workflow.ExecuteActivity(claimCtx, targetRecordingActs.ClaimAndStartRun, store.ClaimRunInput{
		TicketID:  in.TicketID,
		RunID:     in.RunID,
		StartedAt: workflow.Now(ctx),
	}).Get(claimCtx, &claimed); err != nil {
		return fmt.Errorf("claiming ticket %d: %w", in.TicketID, err)
	}

	branch := work.FactoryTicketBranchName(int64(claimed.Ticket.ID), in.RunID)
	controlCtx := workflow.WithActivityOptions(ctx, targetActivityOptions(in.Policy.Provisioning))
	if err := workflow.ExecuteActivity(controlCtx, runWorkerControlActs.ProvisionRunWorker, activities.ProvisionRunWorkerInput{
		TicketNumber: int(claimed.Ticket.ID),
		Identity:     identity,
		Branch:       branch,
	}).Get(controlCtx, nil); err != nil {
		return fmt.Errorf("provisioning Run Worker generation one: %w", err)
	}

	privateQueue, err := work.RunWorkerTaskQueue(identity)
	if err != nil {
		return fmt.Errorf("building Run Worker private task queue: %w", err)
	}
	sessionOptions := targetActivityOptions(in.Policy.Provisioning)
	sessionOptions.TaskQueue = privateQueue
	sessionCtx, err := workflow.CreateSession(workflow.WithActivityOptions(ctx, sessionOptions), &workflow.SessionOptions{
		ExecutionTimeout: in.Policy.HardDeadline,
		CreationTimeout:  in.Policy.Provisioning.ScheduleToCloseTimeout,
		HeartbeatTimeout: in.Policy.Agent.HeartbeatTimeout,
	})
	if err != nil {
		return fmt.Errorf("creating Run Worker Session: %w", err)
	}
	sessionOpen := true
	defer func() {
		if sessionOpen {
			workflow.CompleteSession(sessionCtx)
		}
	}()

	if err := startTargetStep(ctx, in, 1, work.StepCloneRepository); err != nil {
		return err
	}
	var clone activities.CloneTargetRepositoryOutput
	if err := workflow.ExecuteActivity(sessionCtx, targetRunWorkerActs.CloneTargetRepository, activities.CloneTargetRepositoryInput{
		Step:     activities.RepositoryStep{StepOrdinal: 1, Branch: branch},
		CloneURL: in.CloneURL,
	}).Get(sessionCtx, &clone); err != nil {
		return fmt.Errorf("cloning the target repository: %w", err)
	}

	detail := work.TicketDetail{Ticket: work.Ticket{Number: int(claimed.Ticket.ID), Title: claimed.Ticket.Title, Body: claimed.Ticket.Body}}
	ordinal, agentAttempts, reviewSteps := 2, 0, 0
	plan, err := runTargetAgentStep(ctx, sessionCtx, in, identity, detail, ordinal, work.AgentStagePlan, work.PriorTurns{}, work.AgentPromptContext{}, nil, 1)
	if err != nil {
		return err
	}
	agentAttempts++
	ordinal++
	implement, err := runTargetAgentStep(ctx, sessionCtx, in, identity, detail, ordinal, work.AgentStageImplement, work.PriorTurns{Plan: plan.Result}, work.AgentPromptContext{}, nil, 1)
	if err != nil {
		return err
	}
	agentAttempts++
	ordinal++
	implementTurn := 1
	var pullRequest work.PullRequest
	var mergeStep activities.RepositoryStep
	var merge work.PullRequestMergeResult
	var replacementCandidate *work.PullRequest
	ready := false
	var feedback work.AgentPromptContext
	var latestReview work.StageOutput
	var reviewLedger []work.ReviewTurnRecord

	for {
		if replacementCandidate != nil {
			pullRequest = *replacementCandidate
			replacementCandidate = nil
		} else {
			syncStep := activities.RepositoryStep{StepOrdinal: ordinal, Branch: branch, PushedHead: clone.HeadSHA}
			if err := startTargetStep(ctx, in, syncStep.StepOrdinal, work.StepSyncPullRequest); err != nil {
				return err
			}
			ordinal++
			if err := workflow.ExecuteActivity(sessionCtx, targetRunWorkerActs.TargetSyncPullRequest, activities.TargetSyncPullRequestInput{
				Step: syncStep, Title: implementTitle(implement.Result), Body: implementBody(implement.Result), Existing: optionalPullRequest(pullRequest),
			}).Get(sessionCtx, &pullRequest); err != nil {
				return fmt.Errorf("synchronizing target pull request: %w", err)
			}
		}
		if strings.TrimSpace(pullRequest.HeadSHA) == "" || pullRequest.Number <= 0 || strings.TrimSpace(pullRequest.NodeID) == "" {
			return temporal.NewNonRetryableApplicationError("target pull request does not identify an authoritative candidate head", activities.ErrTypeInvalid, nil)
		}

		candidate := activities.RepositoryStep{StepOrdinal: ordinal, Branch: branch, PushedHead: pullRequest.HeadSHA, PullRequestNumber: pullRequest.Number, PullRequestNodeID: pullRequest.NodeID}
		if err := startTargetStep(ctx, in, candidate.StepOrdinal, work.StepAwaitCI); err != nil {
			return err
		}
		ordinal++
		ciCtx := workflow.WithActivityOptions(sessionCtx, targetActivityOptions(in.Policy.AwaitCI))
		var ci activities.AwaitCIOutput
		if err := workflow.ExecuteActivity(ciCtx, targetRunWorkerActs.TargetAwaitCI, activities.TargetAwaitCIInput{Step: candidate, CI: activities.AwaitCIInput{CommitSHA: candidate.PushedHead, RequiredChecks: in.Policy.RequiredChecks}}).Get(ciCtx, &ci); err != nil {
			return fmt.Errorf("awaiting target CI for %s: %w", candidate.PushedHead, err)
		}
		if ci.CommitSHA != candidate.PushedHead {
			return temporal.NewNonRetryableApplicationError(fmt.Sprintf("target CI returned another candidate %q", ci.CommitSHA), activities.ErrTypeInvalid, nil)
		}
		if !ci.Green {
			if agentAttempts >= in.Policy.MaxAgentAttempts {
				return exhaustedAgentAttempts(in.Policy.MaxAgentAttempts)
			}
			implementTurn++
			feedback = work.AgentPromptContext{CandidateHeadSHA: candidate.PushedHead, CIFailures: ci.RedFailures}
			implement, err = runTargetAgentStep(ctx, sessionCtx, in, identity, detail, ordinal, work.AgentStageImplement, work.PriorTurns{Plan: plan.Result, LatestImplement: implement.Result}, feedback, &activities.ProviderThreadContinuation{Identity: identity, ThreadID: implement.ThreadID}, implementTurn)
			if err != nil {
				return err
			}
			agentAttempts++
			ordinal++
			continue
		}
		if reviewSteps >= in.Policy.MaxReviewSteps {
			return exhaustedReviewSteps(in.Policy.MaxReviewSteps)
		}
		if agentAttempts >= in.Policy.MaxAgentAttempts {
			return exhaustedAgentAttempts(in.Policy.MaxAgentAttempts)
		}
		reviewSteps++
		review, reviewErr := runTargetAgentStep(ctx, sessionCtx, in, identity, detail, ordinal, work.AgentStageReview, work.PriorTurns{Plan: plan.Result, LatestImplement: implement.Result, LatestReview: latestReview, ReviewLedger: reviewLedger}, work.AgentPromptContext{CandidateHeadSHA: candidate.PushedHead}, nil, reviewSteps)
		if reviewErr != nil {
			return reviewErr
		}
		agentAttempts++
		ordinal++
		findings, ok := review.Result.Value().(work.ReviewOutput)
		if !ok {
			return temporal.NewNonRetryableApplicationError("target review produced an invalid result", activities.ErrTypeInvalid, nil)
		}
		latestReview = review.Result
		reviewLedger = append(reviewLedger, work.ReviewTurnRecord{Turn: reviewSteps, Findings: findings.Findings, Verified: findings.Verified})
		if len(findings.BlockingFindingIDs()) != 0 {
			if agentAttempts >= in.Policy.MaxAgentAttempts {
				return exhaustedAgentAttempts(in.Policy.MaxAgentAttempts)
			}
			implementTurn++
			feedback = work.AgentPromptContext{CandidateHeadSHA: candidate.PushedHead, ReviewFindings: findings.Findings}
			implement, err = runTargetAgentStep(ctx, sessionCtx, in, identity, detail, ordinal, work.AgentStageImplement, work.PriorTurns{Plan: plan.Result, LatestImplement: implement.Result, LatestReview: latestReview}, feedback, &activities.ProviderThreadContinuation{Identity: identity, ThreadID: implement.ThreadID}, implementTurn)
			if err != nil {
				return err
			}
			agentAttempts++
			ordinal++
			continue
		}
		if !ready {
			readyStep := activities.RepositoryStep{StepOrdinal: ordinal, Branch: branch, PushedHead: candidate.PushedHead, PullRequestNumber: pullRequest.Number, PullRequestNodeID: pullRequest.NodeID}
			if err := startTargetStep(ctx, in, readyStep.StepOrdinal, work.StepMarkPullRequestReady); err != nil {
				return err
			}
			ordinal++
			if err := workflow.ExecuteActivity(sessionCtx, targetRunWorkerActs.TargetMarkPullRequestReady, activities.TargetMarkPullRequestReadyInput{Step: readyStep}).Get(sessionCtx, nil); err != nil {
				return fmt.Errorf("marking target pull request ready: %w", err)
			}
			ready = true
		}
		mergeStep = activities.RepositoryStep{StepOrdinal: ordinal, Branch: branch, PushedHead: candidate.PushedHead, PullRequestNumber: pullRequest.Number, PullRequestNodeID: pullRequest.NodeID}
		if err := startTargetStep(ctx, in, mergeStep.StepOrdinal, work.StepMergePullRequest); err != nil {
			return err
		}
		ordinal++
		mergeCtx := workflow.WithActivityOptions(sessionCtx, targetActivityOptions(in.Policy.Merge))
		if err := workflow.ExecuteActivity(mergeCtx, targetRunWorkerActs.TargetMergePullRequest, activities.TargetMergePullRequestInput{Step: mergeStep, ExpectedHeadSHA: candidate.PushedHead}).Get(mergeCtx, &merge); err != nil {
			return fmt.Errorf("merging reviewed target candidate %s: %w", candidate.PushedHead, err)
		}
		if merge.Outcome == work.PullRequestMergeConfirmed && strings.TrimSpace(merge.MergeSHA) != "" {
			break
		}
		if merge.Outcome == work.PullRequestMergeHeadChanged {
			if strings.TrimSpace(merge.PullRequest.HeadSHA) == "" {
				return temporal.NewNonRetryableApplicationError("target merge reported a changed head without its SHA", activities.ErrTypeInvalid, nil)
			}
			updated := merge.PullRequest
			if updated.Number == 0 {
				updated.Number = pullRequest.Number
			}
			if updated.NodeID == "" {
				updated.NodeID = pullRequest.NodeID
			}
			replacementCandidate = &updated
			continue
		}
		if merge.Outcome != work.PullRequestMergeTextConflict && merge.Outcome != work.PullRequestMergeBaseRefreshRequired {
			return temporal.NewNonRetryableApplicationError(fmt.Sprintf("target merge did not confirm candidate %q", candidate.PushedHead), activities.ErrTypeInvalid, nil)
		}
		if agentAttempts >= in.Policy.MaxAgentAttempts {
			return exhaustedAgentAttempts(in.Policy.MaxAgentAttempts)
		}
		implementTurn++
		feedback = work.AgentPromptContext{CandidateHeadSHA: candidate.PushedHead, Merge: &work.MergeFeedback{Outcome: merge.Outcome, ReviewedHeadSHA: candidate.PushedHead, CurrentHeadSHA: merge.PullRequest.HeadSHA, CurrentBaseSHA: merge.PullRequest.BaseSHA, Diagnostic: merge.Diagnostic}}
		implement, err = runTargetAgentStep(ctx, sessionCtx, in, identity, detail, ordinal, work.AgentStageImplement, work.PriorTurns{Plan: plan.Result, LatestImplement: implement.Result, LatestReview: latestReview}, feedback, &activities.ProviderThreadContinuation{Identity: identity, ThreadID: implement.ThreadID}, implementTurn)
		if err != nil {
			return err
		}
		agentAttempts++
		ordinal++
	}

	finalCtx := workflow.WithActivityOptions(ctx, targetActivityOptions(in.Policy.Recording))
	if err := workflow.ExecuteActivity(finalCtx, targetRecordingActs.FinalizeConfirmedMerge, store.ConfirmedMergeInput{
		RunID: in.RunID, TicketID: in.TicketID, StepOrdinal: mergeStep.StepOrdinal,
		ReviewedHead: mergeStep.PushedHead, MergeSHA: merge.MergeSHA, EndedAt: workflow.Now(ctx),
	}).Get(finalCtx, nil); err != nil {
		return fmt.Errorf("recording confirmed target merge: %w", err)
	}

	workflow.CompleteSession(sessionCtx)
	sessionOpen = false
	teardownCtx := workflow.WithActivityOptions(ctx, targetActivityOptions(in.Policy.Teardown))
	_ = workflow.ExecuteActivity(teardownCtx, runWorkerControlActs.DeleteRunWorker, activities.DeleteRunWorkerInput{Identity: identity}).Get(teardownCtx, nil)
	return nil
}

func startTargetStep(ctx workflow.Context, in WorkOnTicketInput, ordinal int, kind work.StepKind) error {
	recordingCtx := workflow.WithActivityOptions(ctx, targetActivityOptions(in.Policy.Recording))
	if err := workflow.ExecuteActivity(recordingCtx, targetRecordingActs.StartStep, store.StartStepInput{
		RunID: in.RunID, Ordinal: ordinal, Kind: kind, StartedAt: workflow.Now(ctx),
	}).Get(recordingCtx, nil); err != nil {
		return fmt.Errorf("starting %s step %d: %w", kind, ordinal, err)
	}
	return nil
}

func runTargetAgentStep(ctx workflow.Context, sessionCtx workflow.Context, in WorkOnTicketInput, identity work.RunWorkerIdentity, detail work.TicketDetail, ordinal int, stage work.AgentStage, prior work.PriorTurns, promptContext work.AgentPromptContext, continuation *activities.ProviderThreadContinuation, iteration int) (activities.TargetAgentOutput, error) {
	if err := promptContext.Validate(); err != nil {
		return activities.TargetAgentOutput{}, temporal.NewNonRetryableApplicationError(fmt.Sprintf("validating %s prompt context: %v", stage, err), activities.ErrTypeInvalid, nil)
	}
	if err := startTargetStep(ctx, in, ordinal, agentStepKind(stage)); err != nil {
		return activities.TargetAgentOutput{}, err
	}
	attempt := store.TargetAttemptID{RunID: in.RunID, StepOrdinal: ordinal, AttemptNo: 1}
	recordingCtx := workflow.WithActivityOptions(ctx, targetActivityOptions(in.Policy.Recording))
	if err := workflow.ExecuteActivity(recordingCtx, targetRecordingActs.StartAgentAttempt, store.StartAgentAttemptInput{
		ID: attempt, AgentStage: stage, Model: in.Model, UsageState: work.UsageUnknown, StartedAt: workflow.Now(ctx),
	}).Get(recordingCtx, nil); err != nil {
		return activities.TargetAgentOutput{}, fmt.Errorf("authorizing %s agent attempt: %w", stage, err)
	}
	controlCtx := workflow.WithActivityOptions(ctx, targetActivityOptions(in.Policy.Provisioning))
	if err := workflow.ExecuteActivity(controlCtx, runWorkerControlActs.AuthorizeRunWorkerAttempt, activities.AuthorizeRunWorkerAttemptInput{
		Identity: identity, AttemptID: attempt,
	}).Get(controlCtx, nil); err != nil {
		return activities.TargetAgentOutput{}, fmt.Errorf("installing %s checkpoint capability: %w", stage, err)
	}
	credentialCtx := workflow.WithActivityOptions(ctx, targetActivityOptions(in.Policy.CredentialRotation))
	var revision work.RunWorkerCredentialRevision
	if err := workflow.ExecuteActivity(credentialCtx, runWorkerControlActs.RotateRunWorkerGitHubCredential, activities.RotateRunWorkerGitHubCredentialInput{Identity: identity}).Get(credentialCtx, &revision); err != nil {
		return activities.TargetAgentOutput{}, fmt.Errorf("rotating %s GitHub credential: %w", stage, err)
	}
	if err := revision.Validate(); err != nil {
		return activities.TargetAgentOutput{}, fmt.Errorf("validating %s credential revision: %w", stage, err)
	}
	agentCtx, cancelAgent := workflow.WithCancel(workflow.WithActivityOptions(sessionCtx, targetAgentActivityOptions(in.Policy.Agent)))
	defer cancelAgent()
	var out activities.TargetAgentOutput
	agentFuture := workflow.ExecuteActivity(agentCtx, targetRunWorkerActs.RunTargetAgent, activities.TargetAgentInput{
		AttemptID: attempt, TicketNumber: detail.Number, Iteration: iteration, Stage: stage, Model: in.Model,
		Detail: detail, Prior: prior, PromptContext: promptContext, MaxReviewSteps: in.Policy.MaxReviewSteps, PriorProviderThread: continuation,
		CredentialRevision: activities.CredentialRevisionExpectation{Identity: identity, Revision: revision.Revision},
	})
	renewalCtx, cancelRenewal := workflow.WithCancel(ctx)
	defer cancelRenewal()
	for {
		completed := false
		var agentErr error
		selector := workflow.NewSelector(ctx)
		selector.AddFuture(agentFuture, func(f workflow.Future) {
			completed = true
			agentErr = f.Get(agentCtx, &out)
		})
		selector.AddFuture(workflow.NewTimer(renewalCtx, credentialRenewalInterval), func(workflow.Future) {})
		selector.Select(ctx)
		if completed {
			if agentErr != nil {
				return activities.TargetAgentOutput{}, fmt.Errorf("running %s agent attempt: %w", stage, agentErr)
			}
			break
		}
		var renewed work.RunWorkerCredentialRevision
		if err := workflow.ExecuteActivity(controlCtx, runWorkerControlActs.RotateRunWorkerGitHubCredential, activities.RotateRunWorkerGitHubCredentialInput{Identity: identity}).Get(controlCtx, &renewed); err != nil {
			cancelAgent()
			return activities.TargetAgentOutput{}, fmt.Errorf("renewing %s GitHub credential: %w", stage, err)
		}
		if err := renewed.Validate(); err != nil {
			cancelAgent()
			return activities.TargetAgentOutput{}, fmt.Errorf("validating renewed %s credential revision: %w", stage, err)
		}
	}
	if len(out.Output) == 0 {
		return activities.TargetAgentOutput{}, temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("%s agent produced no durable result", stage), activities.ErrTypeInvalid, nil)
	}
	if err := workflow.ExecuteActivity(recordingCtx, targetRecordingActs.CompleteStep, in.RunID, ordinal, workflow.Now(ctx), out.Output).Get(recordingCtx, nil); err != nil {
		return activities.TargetAgentOutput{}, fmt.Errorf("completing %s step %d: %w", stage, ordinal, err)
	}
	return out, nil
}

func agentStepKind(stage work.AgentStage) work.StepKind {
	switch stage {
	case work.AgentStagePlan:
		return work.StepPlan
	case work.AgentStageImplement:
		return work.StepImplement
	case work.AgentStageReview:
		return work.StepReview
	default:
		return ""
	}
}

func optionalPullRequest(pullRequest work.PullRequest) *work.PullRequest {
	if pullRequest.Number <= 0 {
		return nil
	}
	return &pullRequest
}

func exhaustedReviewSteps(limit int) error {
	return temporal.NewNonRetryableApplicationError(
		fmt.Sprintf("target run exhausted its %d review-step budget", limit), activities.ErrTypeInvalid, nil)
}

func exhaustedAgentAttempts(limit int) error {
	return temporal.NewNonRetryableApplicationError(
		fmt.Sprintf("target run exhausted its %d agent-attempt budget", limit), activities.ErrTypeInvalid, nil)
}

func implementTitle(out work.StageOutput) string {
	implemented, ok := out.Value().(work.ImplementOutput)
	if !ok {
		return ""
	}
	return implemented.Title
}

func implementBody(out work.StageOutput) string {
	implemented, ok := out.Value().(work.ImplementOutput)
	if !ok {
		return ""
	}
	return implemented.Body
}

func validateWorkOnTicket(in WorkOnTicketInput) error {
	if in.TicketID <= 0 {
		return temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("ticket id %d is not a target Ticket", in.TicketID),
			activities.ErrTypeInvalid,
			nil,
		)
	}
	if err := in.Policy.Validate(); err != nil {
		return temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("the target run policy for ticket %d is unusable: %v", in.TicketID, err),
			activities.ErrTypeInvalid,
			nil,
		)
	}
	if strings.TrimSpace(in.CloneURL) == "" {
		return temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("ticket %d has no repository clone URL", in.TicketID),
			activities.ErrTypeInvalid,
			nil,
		)
	}
	if err := in.Model.Validate(); err != nil {
		return temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("the target model for ticket %d is unusable: %v", in.TicketID, err),
			activities.ErrTypeInvalid,
			nil,
		)
	}
	return nil
}

func targetActivityOptions(policy work.ActivityPolicy) workflow.ActivityOptions {
	return workflow.ActivityOptions{
		StartToCloseTimeout:    policy.StartToCloseTimeout,
		ScheduleToCloseTimeout: policy.ScheduleToCloseTimeout,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    policy.Retry.InitialInterval,
			BackoffCoefficient: policy.Retry.BackoffCoefficient,
			MaximumInterval:    policy.Retry.MaximumInterval,
			MaximumAttempts:    policy.Retry.MaximumAttempts,
		},
	}
}

func targetAgentActivityOptions(policy work.AgentActivityPolicy) workflow.ActivityOptions {
	return workflow.ActivityOptions{
		StartToCloseTimeout:    policy.StartToCloseTimeout,
		ScheduleToCloseTimeout: policy.ScheduleToCloseTimeout,
		HeartbeatTimeout:       policy.HeartbeatTimeout,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    policy.Retry.InitialInterval,
			BackoffCoefficient: policy.Retry.BackoffCoefficient,
			MaximumInterval:    policy.Retry.MaximumInterval,
			MaximumAttempts:    policy.Retry.MaximumAttempts,
		},
	}
}
