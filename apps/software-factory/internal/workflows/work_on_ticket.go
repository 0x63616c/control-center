package workflows

import (
	"errors"
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

type semanticDeadlineContextKey struct{}

// WorkOnTicket claims one Ticket before creating generation one, creates its
// private Run Worker Session, and clones the repository as that Session's
// first repository-affine activity.
func WorkOnTicket(ctx workflow.Context, in WorkOnTicketInput) (runErr error) {
	var claimed store.ClaimRunResult
	var session *targetRunSession
	claimedRun := false
	defer func() {
		if !claimedRun {
			return
		}
		if outcome, failureKind, failed := terminalFailureKind(runErr); failed {
			terminalCtx, cancel := workflow.NewDisconnectedContext(ctx)
			defer cancel()
			finalCtx := workflow.WithActivityOptions(terminalCtx, targetActivityOptions(in.Policy.Recording))
			if err := workflow.ExecuteActivity(finalCtx, targetRecordingActs.FinalizeRunFailure, store.RunFailureInput{RunID: in.RunID, TicketID: in.TicketID, Outcome: outcome, FailureKind: failureKind, EndedAt: workflow.Now(terminalCtx)}).Get(finalCtx, nil); err != nil {
				runErr = fmt.Errorf("recording failed target run: %w", err)
				return
			}
			if session != nil {
				session.close()
				session.delete(terminalCtx)
			}
			return
		}
		if !temporal.IsCanceledError(runErr) {
			return
		}
		cleanupCtx, cancel := workflow.NewDisconnectedContext(ctx)
		defer cancel()
		finalCtx := workflow.WithActivityOptions(cleanupCtx, targetActivityOptions(in.Policy.Recording))
		if err := workflow.ExecuteActivity(finalCtx, targetRecordingActs.CancelRun, store.CancelRunInput{
			RunID: in.RunID, TicketID: in.TicketID, EndedAt: workflow.Now(cleanupCtx),
		}).Get(finalCtx, nil); err != nil {
			runErr = fmt.Errorf("recording canceled target run: %w", err)
			return
		}
		if session != nil {
			session.close()
			session.delete(cleanupCtx)
		}
	}()
	if err := validateWorkOnTicket(in); err != nil {
		return err
	}
	claimCtx := workflow.WithActivityOptions(ctx, targetActivityOptions(in.Policy.Recording))
	if err := workflow.ExecuteActivity(claimCtx, targetRecordingActs.ClaimAndStartRun, store.ClaimRunInput{
		TicketID:  in.TicketID,
		RunID:     in.RunID,
		StartedAt: workflow.Now(ctx),
	}).Get(claimCtx, &claimed); err != nil {
		return fmt.Errorf("claiming ticket %d: %w", in.TicketID, err)
	}
	claimedRun = true
	ctx = workflow.WithValue(ctx, semanticDeadlineContextKey{}, workflow.Now(ctx).Add(in.Policy.SemanticDeadline))

	branch := work.FactoryTicketBranchName(int64(claimed.Ticket.ID), in.RunID)
	session, err := newTargetRunSession(ctx, in, int(claimed.Ticket.ID), branch)
	if err != nil {
		return err
	}
	defer session.close()

	if err := startTargetStep(ctx, in, 1, work.StepCloneRepository); err != nil {
		return err
	}
	var clone activities.CloneTargetRepositoryOutput
	if err := session.execute(ctx, func(sessionCtx workflow.Context) error {
		return workflow.ExecuteActivity(sessionCtx, targetRunWorkerActs.CloneTargetRepository, activities.CloneTargetRepositoryInput{
			Step:     activities.RepositoryStep{StepOrdinal: 1, Branch: branch},
			CloneURL: in.CloneURL,
		}).Get(sessionCtx, &clone)
	}); err != nil {
		return fmt.Errorf("cloning the target repository: %w", err)
	}
	session.checkoutReady = true

	detail := work.TicketDetail{Ticket: work.Ticket{Number: int(claimed.Ticket.ID), Title: claimed.Ticket.Title, Body: claimed.Ticket.Body}}
	ordinal, agentAttempts, reviewSteps := 2, 0, 0
	plan, used, err := runTargetAgentStep(ctx, session, in, detail, ordinal, work.AgentStagePlan, work.PriorTurns{}, work.AgentPromptContext{}, nil, 1, in.Policy.MaxAgentAttempts-agentAttempts)
	agentAttempts += used
	if err != nil {
		return err
	}
	ordinal++
	implement, used, err := runTargetAgentStep(ctx, session, in, detail, ordinal, work.AgentStageImplement, work.PriorTurns{Plan: plan.Result}, work.AgentPromptContext{}, nil, 1, in.Policy.MaxAgentAttempts-agentAttempts)
	agentAttempts += used
	if err != nil {
		return err
	}
	implementIdentity := session.identity
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
			if err := session.execute(ctx, func(sessionCtx workflow.Context) error {
				return workflow.ExecuteActivity(sessionCtx, targetRunWorkerActs.TargetSyncPullRequest, activities.TargetSyncPullRequestInput{
					Step: syncStep, Title: implementTitle(implement.Result), Body: implementBody(implement.Result), Existing: optionalPullRequest(pullRequest),
				}).Get(sessionCtx, &pullRequest)
			}); err != nil {
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
		var ci activities.AwaitCIOutput
		if err := session.execute(ctx, func(sessionCtx workflow.Context) error {
			ciCtx := workflow.WithActivityOptions(sessionCtx, targetActivityOptions(in.Policy.AwaitCI))
			return workflow.ExecuteActivity(ciCtx, targetRunWorkerActs.TargetAwaitCI, activities.TargetAwaitCIInput{Step: candidate, CI: activities.AwaitCIInput{CommitSHA: candidate.PushedHead, RequiredChecks: in.Policy.RequiredChecks}}).Get(ciCtx, &ci)
		}); err != nil {
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
			implement, used, err = runTargetAgentStep(ctx, session, in, detail, ordinal, work.AgentStageImplement, work.PriorTurns{Plan: plan.Result, LatestImplement: implement.Result}, feedback, sameGenerationContinuation(session, implementIdentity, implement.ThreadID), implementTurn, in.Policy.MaxAgentAttempts-agentAttempts)
			agentAttempts += used
			if err != nil {
				return err
			}
			implementIdentity = session.identity
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
		review, used, reviewErr := runTargetAgentStep(ctx, session, in, detail, ordinal, work.AgentStageReview, work.PriorTurns{Plan: plan.Result, LatestImplement: implement.Result, LatestReview: latestReview, ReviewLedger: reviewLedger}, work.AgentPromptContext{CandidateHeadSHA: candidate.PushedHead}, nil, reviewSteps, in.Policy.MaxAgentAttempts-agentAttempts)
		agentAttempts += used
		if reviewErr != nil {
			return reviewErr
		}
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
			implement, used, err = runTargetAgentStep(ctx, session, in, detail, ordinal, work.AgentStageImplement, work.PriorTurns{Plan: plan.Result, LatestImplement: implement.Result, LatestReview: latestReview}, feedback, sameGenerationContinuation(session, implementIdentity, implement.ThreadID), implementTurn, in.Policy.MaxAgentAttempts-agentAttempts)
			agentAttempts += used
			if err != nil {
				return err
			}
			implementIdentity = session.identity
			ordinal++
			continue
		}
		if !ready {
			readyStep := activities.RepositoryStep{StepOrdinal: ordinal, Branch: branch, PushedHead: candidate.PushedHead, PullRequestNumber: pullRequest.Number, PullRequestNodeID: pullRequest.NodeID}
			if err := startTargetStep(ctx, in, readyStep.StepOrdinal, work.StepMarkPullRequestReady); err != nil {
				return err
			}
			ordinal++
			if err := session.execute(ctx, func(sessionCtx workflow.Context) error {
				return workflow.ExecuteActivity(sessionCtx, targetRunWorkerActs.TargetMarkPullRequestReady, activities.TargetMarkPullRequestReadyInput{Step: readyStep}).Get(sessionCtx, nil)
			}); err != nil {
				return fmt.Errorf("marking target pull request ready: %w", err)
			}
			ready = true
		}
		mergeStep = activities.RepositoryStep{StepOrdinal: ordinal, Branch: branch, PushedHead: candidate.PushedHead, PullRequestNumber: pullRequest.Number, PullRequestNodeID: pullRequest.NodeID}
		if err := startTargetStep(ctx, in, mergeStep.StepOrdinal, work.StepMergePullRequest); err != nil {
			return err
		}
		ordinal++
		if err := session.execute(ctx, func(sessionCtx workflow.Context) error {
			mergeCtx := workflow.WithActivityOptions(sessionCtx, targetActivityOptions(in.Policy.Merge))
			return workflow.ExecuteActivity(mergeCtx, targetRunWorkerActs.TargetMergePullRequest, activities.TargetMergePullRequestInput{Step: mergeStep, ExpectedHeadSHA: candidate.PushedHead}).Get(mergeCtx, &merge)
		}); err != nil {
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
		implement, used, err = runTargetAgentStep(ctx, session, in, detail, ordinal, work.AgentStageImplement, work.PriorTurns{Plan: plan.Result, LatestImplement: implement.Result, LatestReview: latestReview}, feedback, sameGenerationContinuation(session, implementIdentity, implement.ThreadID), implementTurn, in.Policy.MaxAgentAttempts-agentAttempts)
		agentAttempts += used
		if err != nil {
			return err
		}
		implementIdentity = session.identity
		ordinal++
	}

	terminalCtx, cancelTerminal := workflow.NewDisconnectedContext(ctx)
	defer cancelTerminal()
	finalCtx := workflow.WithActivityOptions(terminalCtx, targetActivityOptions(in.Policy.Recording))
	if err := workflow.ExecuteActivity(finalCtx, targetRecordingActs.FinalizeConfirmedMerge, store.ConfirmedMergeInput{
		RunID: in.RunID, TicketID: in.TicketID, StepOrdinal: mergeStep.StepOrdinal,
		ReviewedHead: mergeStep.PushedHead, MergeSHA: merge.MergeSHA, EndedAt: workflow.Now(terminalCtx),
	}).Get(finalCtx, nil); err != nil {
		return fmt.Errorf("recording confirmed target merge: %w", err)
	}

	session.close()
	session.delete(terminalCtx)
	return nil
}

func startTargetStep(ctx workflow.Context, in WorkOnTicketInput, ordinal int, kind work.StepKind) error {
	if err := requireSemanticTime(ctx); err != nil {
		return err
	}
	recordingCtx := workflow.WithActivityOptions(ctx, targetActivityOptions(in.Policy.Recording))
	if err := workflow.ExecuteActivity(recordingCtx, targetRecordingActs.StartStep, store.StartStepInput{
		RunID: in.RunID, Ordinal: ordinal, Kind: kind, StartedAt: workflow.Now(ctx),
	}).Get(recordingCtx, nil); err != nil {
		return fmt.Errorf("starting %s step %d: %w", kind, ordinal, err)
	}
	return nil
}

func runTargetAgentStep(ctx workflow.Context, session *targetRunSession, in WorkOnTicketInput, detail work.TicketDetail, ordinal int, stage work.AgentStage, prior work.PriorTurns, promptContext work.AgentPromptContext, continuation *activities.ProviderThreadContinuation, iteration, remainingAttempts int) (activities.TargetAgentOutput, int, error) {
	if err := promptContext.Validate(); err != nil {
		return activities.TargetAgentOutput{}, 0, temporal.NewNonRetryableApplicationError(fmt.Sprintf("validating %s prompt context: %v", stage, err), activities.ErrTypeInvalid, nil)
	}
	if remainingAttempts <= 0 {
		return activities.TargetAgentOutput{}, 0, exhaustedAgentAttempts(in.Policy.MaxAgentAttempts)
	}
	if err := startTargetStep(ctx, in, ordinal, agentStepKind(stage)); err != nil {
		return activities.TargetAgentOutput{}, 0, err
	}
	recordingCtx := workflow.WithActivityOptions(ctx, targetActivityOptions(in.Policy.Recording))
	controlCtx := workflow.WithActivityOptions(ctx, targetActivityOptions(in.Policy.Provisioning))
	credentialCtx := workflow.WithActivityOptions(ctx, targetActivityOptions(in.Policy.CredentialRotation))
	attemptContinuation := continuation
	attemptStartedAt := make(map[int]time.Time, remainingAttempts)
	for attemptNo := 1; attemptNo <= remainingAttempts; {
		if err := requireSemanticTime(ctx); err != nil {
			return activities.TargetAgentOutput{}, attemptNo - 1, err
		}
		attempt := store.TargetAttemptID{RunID: in.RunID, StepOrdinal: ordinal, AttemptNo: attemptNo}
		startedAt, exists := attemptStartedAt[attemptNo]
		if !exists {
			startedAt = workflow.Now(ctx)
			attemptStartedAt[attemptNo] = startedAt
		}
		if err := workflow.ExecuteActivity(recordingCtx, targetRecordingActs.StartAgentAttempt, store.StartAgentAttemptInput{
			ID: attempt, AgentStage: stage, Model: in.Model, UsageState: work.UsageUnknown, StartedAt: startedAt,
		}).Get(recordingCtx, nil); err != nil {
			return activities.TargetAgentOutput{}, attemptNo - 1, fmt.Errorf("authorizing %s agent attempt: %w", stage, err)
		}
		if err := workflow.ExecuteActivity(controlCtx, runWorkerControlActs.AuthorizeRunWorkerAttempt, activities.AuthorizeRunWorkerAttemptInput{
			Identity: session.identity, AttemptID: attempt,
		}).Get(controlCtx, nil); err != nil {
			return activities.TargetAgentOutput{}, attemptNo, fmt.Errorf("installing %s checkpoint capability: %w", stage, err)
		}
		var revision work.RunWorkerCredentialRevision
		if err := workflow.ExecuteActivity(credentialCtx, runWorkerControlActs.RotateRunWorkerGitHubCredential, activities.RotateRunWorkerGitHubCredentialInput{Identity: session.identity}).Get(credentialCtx, &revision); err != nil {
			return activities.TargetAgentOutput{}, attemptNo, fmt.Errorf("rotating %s GitHub credential: %w", stage, err)
		}
		if err := revision.Validate(); err != nil {
			return activities.TargetAgentOutput{}, attemptNo, fmt.Errorf("validating %s credential revision: %w", stage, err)
		}
		agentCtx, cancelAgent := workflow.WithCancel(workflow.WithActivityOptions(session.sessionCtx, targetAgentActivityOptions(in.Policy.Agent)))
		var out activities.TargetAgentOutput
		agentFuture := workflow.ExecuteActivity(agentCtx, targetRunWorkerActs.RunTargetAgent, activities.TargetAgentInput{
			AttemptID: attempt, TicketNumber: detail.Number, Iteration: iteration, Stage: stage, Model: in.Model,
			Detail: detail, Prior: prior, PromptContext: promptContext, MaxReviewSteps: in.Policy.MaxReviewSteps, PriorProviderThread: attemptContinuation,
			CredentialRevision: activities.CredentialRevisionExpectation{Identity: session.identity, Revision: revision.Revision},
		})
		renewalCtx, cancelRenewal := workflow.WithCancel(ctx)
		var agentErr error
		for {
			completed := false
			selector := workflow.NewSelector(ctx)
			selector.AddFuture(agentFuture, func(f workflow.Future) {
				completed = true
				agentErr = f.Get(agentCtx, &out)
			})
			selector.AddFuture(workflow.NewTimer(renewalCtx, credentialRenewalInterval), func(workflow.Future) {})
			selector.Select(ctx)
			if completed {
				break
			}
			var renewed work.RunWorkerCredentialRevision
			if err := workflow.ExecuteActivity(controlCtx, runWorkerControlActs.RotateRunWorkerGitHubCredential, activities.RotateRunWorkerGitHubCredentialInput{Identity: session.identity}).Get(controlCtx, &renewed); err != nil {
				cancelRenewal()
				cancelAgent()
				return activities.TargetAgentOutput{}, attemptNo, fmt.Errorf("renewing %s GitHub credential: %w", stage, err)
			}
			if err := renewed.Validate(); err != nil {
				cancelRenewal()
				cancelAgent()
				return activities.TargetAgentOutput{}, attemptNo, fmt.Errorf("validating renewed %s credential revision: %w", stage, err)
			}
		}
		cancelRenewal()
		cancelAgent()
		if agentErr != nil {
			if isRunWorkerSessionLoss(agentErr) {
				if err := session.replace(ctx); err != nil {
					return activities.TargetAgentOutput{}, attemptNo, fmt.Errorf("replacing lost Run Worker Session: %w", err)
				}
				// The replacement must reconcile this same durable Attempt before
				// deciding it is unresumable. A terminal checkpoint returns without
				// another provider call; an incomplete one reports A12/I08.
				attemptContinuation = nil
				continue
			}
			failureKind := work.RunFailureInfrastructure
			if isUnresumableAttempt(agentErr) {
				failureKind = work.RunFailureAgentUnrecoverable
			}
			if err := workflow.ExecuteActivity(recordingCtx, targetRecordingActs.FailAgentAttempt, store.AgentAttemptFailureInput{
				ID: attempt, FailureKind: failureKind, EndedAt: workflow.Now(ctx),
			}).Get(recordingCtx, nil); err != nil {
				return activities.TargetAgentOutput{}, attemptNo, fmt.Errorf("recording failed %s agent attempt: %w", stage, err)
			}
			if isUnresumableAttempt(agentErr) && attemptNo < remainingAttempts {
				attemptContinuation = nil
				attemptNo++
				continue
			}
			if isUnresumableAttempt(agentErr) {
				return activities.TargetAgentOutput{}, attemptNo, exhaustedAgentAttempts(in.Policy.MaxAgentAttempts)
			}
			return activities.TargetAgentOutput{}, attemptNo, fmt.Errorf("running %s agent attempt: %w", stage, agentErr)
		}
		if len(out.Output) == 0 {
			return activities.TargetAgentOutput{}, attemptNo, temporal.NewNonRetryableApplicationError(
				fmt.Sprintf("%s agent produced no durable result", stage), activities.ErrTypeInvalid, nil)
		}
		if err := workflow.ExecuteActivity(recordingCtx, targetRecordingActs.CompleteStep, in.RunID, ordinal, workflow.Now(ctx), out.Output).Get(recordingCtx, nil); err != nil {
			return activities.TargetAgentOutput{}, attemptNo, fmt.Errorf("completing %s step %d: %w", stage, ordinal, err)
		}
		return out, attemptNo, nil
	}
	return activities.TargetAgentOutput{}, remainingAttempts, exhaustedAgentAttempts(in.Policy.MaxAgentAttempts)
}

// targetRunSession owns one live Run Worker generation. It is the only
// workflow-local state allowed to replace that worker, which serializes loss
// recovery and prevents two generations from receiving repository work.
type targetRunSession struct {
	in            WorkOnTicketInput
	ticketNumber  int
	branch        string
	identity      work.RunWorkerIdentity
	sessionCtx    workflow.Context
	open          bool
	checkoutReady bool
}

func newTargetRunSession(ctx workflow.Context, in WorkOnTicketInput, ticketNumber int, branch string) (*targetRunSession, error) {
	session := &targetRunSession{in: in, ticketNumber: ticketNumber, branch: branch}
	if err := session.provisionAndCreate(ctx, 1); err != nil {
		return nil, err
	}
	return session, nil
}

func (s *targetRunSession) provisionAndCreate(ctx workflow.Context, generation int) error {
	identity, err := work.NewRunWorkerIdentity(s.in.RunID, generation)
	if err != nil {
		return temporal.NewNonRetryableApplicationError(fmt.Sprintf("the target Run %q cannot own a Run Worker: %v", s.in.RunID, err), activities.ErrTypeInvalid, nil)
	}
	controlCtx := workflow.WithActivityOptions(ctx, targetActivityOptions(s.in.Policy.Provisioning))
	if err := workflow.ExecuteActivity(controlCtx, runWorkerControlActs.ProvisionRunWorker, activities.ProvisionRunWorkerInput{
		TicketNumber: s.ticketNumber, Identity: identity, Branch: s.branch,
	}).Get(controlCtx, nil); err != nil {
		return fmt.Errorf("provisioning Run Worker generation %d: %w", generation, err)
	}
	privateQueue, err := work.RunWorkerTaskQueue(identity)
	if err != nil {
		s.deleteIdentity(ctx, identity)
		return fmt.Errorf("building Run Worker private task queue: %w", err)
	}
	sessionOptions := targetActivityOptions(s.in.Policy.Provisioning)
	sessionOptions.TaskQueue = privateQueue
	sessionCtx, err := workflow.CreateSession(workflow.WithActivityOptions(ctx, sessionOptions), &workflow.SessionOptions{
		ExecutionTimeout: s.in.Policy.HardDeadline, CreationTimeout: s.in.Policy.Provisioning.ScheduleToCloseTimeout, HeartbeatTimeout: s.in.Policy.Agent.HeartbeatTimeout,
	})
	if err != nil {
		s.deleteIdentity(ctx, identity)
		return fmt.Errorf("creating Run Worker Session for generation %d: %w", generation, err)
	}
	s.identity, s.sessionCtx, s.open = identity, sessionCtx, true
	return nil
}

func (s *targetRunSession) execute(ctx workflow.Context, run func(workflow.Context) error) error {
	err := run(s.sessionCtx)
	if !isRunWorkerSessionLoss(err) {
		return err
	}
	if err := s.replace(ctx); err != nil {
		return fmt.Errorf("replacing lost Run Worker Session: %w", err)
	}
	return run(s.sessionCtx)
}

func (s *targetRunSession) replace(ctx workflow.Context) error {
	s.close()
	s.delete(ctx)
	if err := s.provisionAndCreate(ctx, s.identity.Generation+1); err != nil {
		return err
	}
	if !s.checkoutReady {
		return nil
	}
	if err := workflow.ExecuteActivity(s.sessionCtx, targetRunWorkerActs.RestoreTargetRepository, activities.RestoreTargetRepositoryInput{
		CloneURL: s.in.CloneURL, Branch: s.branch,
	}).Get(s.sessionCtx, nil); err != nil {
		return fmt.Errorf("restoring replacement repository: %w", err)
	}
	return nil
}

func (s *targetRunSession) close() {
	if s.open {
		workflow.CompleteSession(s.sessionCtx)
		s.open = false
	}
}

func (s *targetRunSession) delete(ctx workflow.Context) {
	s.deleteIdentity(ctx, s.identity)
}

func (s *targetRunSession) deleteIdentity(ctx workflow.Context, identity work.RunWorkerIdentity) {
	teardownCtx := workflow.WithActivityOptions(ctx, targetActivityOptions(s.in.Policy.Teardown))
	_ = workflow.ExecuteActivity(teardownCtx, runWorkerControlActs.DeleteRunWorker, activities.DeleteRunWorkerInput{Identity: identity}).Get(teardownCtx, nil)
}

func isUnresumableAttempt(err error) bool {
	var application *temporal.ApplicationError
	return errors.As(err, &application) && application.Type() == activities.ErrTypeUnresumableIncompleteAttempt
}

func isRunWorkerSessionLoss(err error) bool {
	if errors.Is(err, workflow.ErrSessionFailed) {
		return true
	}
	var application *temporal.ApplicationError
	return errors.As(err, &application) && application.Type() == activities.ErrTypeRunWorkerSessionLost
}

func requireSemanticTime(ctx workflow.Context) error {
	deadline, ok := ctx.Value(semanticDeadlineContextKey{}).(time.Time)
	if !ok {
		return temporal.NewNonRetryableApplicationError("target run semantic deadline is unavailable", activities.ErrTypeInvalid, nil)
	}
	if !workflow.Now(ctx).Before(deadline) {
		return temporal.NewNonRetryableApplicationError("target run reached its semantic deadline", activities.ErrTypeSemanticDeadline, nil)
	}
	return nil
}

func terminalFailureKind(err error) (work.RunOutcome, work.RunFailureKind, bool) {
	var application *temporal.ApplicationError
	if errors.As(err, &application) {
		switch application.Type() {
		case activities.ErrTypeSemanticDeadline:
			return work.RunOutcomeFailed, work.RunFailureSemanticDeadline, true
		case activities.ErrTypeAgentAttemptBudget:
			return work.RunOutcomeExhausted, work.RunFailureAgentAttemptBudget, true
		case activities.ErrTypeReviewBudget:
			return work.RunOutcomeExhausted, work.RunFailureReviewBudget, true
		}
	}
	return "", work.RunFailureNone, false
}

func sameGenerationContinuation(session *targetRunSession, identity work.RunWorkerIdentity, threadID string) *activities.ProviderThreadContinuation {
	if identity != session.identity || strings.TrimSpace(threadID) == "" {
		return nil
	}
	return &activities.ProviderThreadContinuation{Identity: identity, ThreadID: threadID}
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
		fmt.Sprintf("target run exhausted its %d review-step budget", limit), activities.ErrTypeReviewBudget, nil)
}

func exhaustedAgentAttempts(limit int) error {
	return temporal.NewNonRetryableApplicationError(
		fmt.Sprintf("target run exhausted its %d agent-attempt budget", limit), activities.ErrTypeAgentAttemptBudget, nil)
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
