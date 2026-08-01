package workflows

import (
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/workflow"
)

// stageUsageAlwaysMeasured preserves the value recorded by pre-AgentWorkflow
// histories. New executions use AgentWorkflowResult.UsageMeasured instead.
const stageUsageAlwaysMeasured = true

// These names exist only to replay FactoryWorkTicket histories started before
// AgentWorkflow replaced the stage activities. No worker registers matching
// implementations in the current deployment.
const (
	legacyRunPlanActivityName      = "RunPlan"
	legacyRunImplementActivityName = "RunImplement"
	legacyRunReviewActivityName    = "RunReview"
)

// factoryImplementReviewLoop is implementReviewLoop's counterpart for the
// Ticket-backed pipeline: the same turn schedule (loop.go's own doc comment
// on implementReviewLoop has the full numbered walk — plan already ran once
// by the time this is called), the same two counters, the same progress
// detection, reused verbatim rather than re-derived. What differs is what
// each turn is recorded into: Postgres via recordStep/recordAttempt/
// persistTranscript instead of a GitHub status comment, and the branch and
// pull request title, which name the Ticket rather than a GitHub issue.
//
// There is no workflow.GetVersion gate here the way loop.go's CI-stagnation
// check has one: FactoryWorkTicket has no history predating this logic to
// stay compatible with, so it always compares full check-failure identities.
func (r *factoryTicketRun) factoryImplementReviewLoop(
	ctx workflow.Context,
	control, stages, ci workflow.Context,
	detail work.TicketDetail,
	prior map[work.Stage][]work.StageOutput,
) (FactoryWorkTicketResult, error) {
	branch := work.FactoryTicketBranchName(int64(r.in.TicketID), r.runID)

	var (
		implementTurn int
		reviewTurn    int
		ciTurns       int
		reviewTurns   int
		lastRed       []work.CheckFailure
		lastBlocking  []string
		pr            work.PullRequest
	)

	for {
		for { // one CI window
			implementTurn++
			out, err := r.runFactoryImplementTurn(ctx, stages, detail, prior, implementTurn)
			if err != nil {
				return FactoryWorkTicketResult{Outcome: work.OutcomeFailed, Usage: r.usage, PullRequest: pr}, err
			}
			prior[work.StageImplement] = append(prior[work.StageImplement], out)

			impl, ok := out.Value().(work.ImplementOutput)
			if !ok {
				return FactoryWorkTicketResult{Outcome: work.OutcomeFailed, Usage: r.usage, PullRequest: pr},
					fmt.Errorf("implement turn %d produced %T, not work.ImplementOutput", implementTurn, out.Value())
			}

			if impl.Blocked {
				return FactoryWorkTicketResult{
					Outcome: work.OutcomeBlocked, Usage: r.usage, PullRequest: pr,
					Detail: impl.BlockedReason,
				}, nil
			}

			pullRequestTitle := fmt.Sprintf("T-%d %s", r.in.TicketID, impl.Title)
			updated, err := r.openOrUpdatePullRequest(control, branch, pullRequestTitle, impl.Body, pr)
			if err != nil {
				return FactoryWorkTicketResult{Outcome: work.OutcomeFailed, Usage: r.usage, PullRequest: pr}, err
			}
			pr = updated

			obs, err := r.observeCI(ci, branch)
			if err != nil {
				return FactoryWorkTicketResult{Outcome: work.OutcomeFailed, Usage: r.usage, PullRequest: pr}, err
			}

			if !obs.Concluded {
				ciTurns++
				if ciTurns >= maxImplementTurnsPerWindow {
					return r.factoryExhausted(pr, fmt.Sprintf(
						"CI did not conclude for %s within %d implement turns in this window", branch, ciTurns)), nil
				}
				continue
			}

			if obs.Green {
				ciTurns = 0
				lastRed = nil
				break // leave the CI window, go to review
			}

			failures := observedFailures(obs)
			if len(failures) > 0 && sameCheckFailures(failures, lastRed) {
				return r.factoryExhausted(pr, fmt.Sprintf(
					"CI failed the same check(s) (%s) on %s as the previous observed turn: no progress",
					checkFailureNames(failures), branch)), nil
			}
			lastRed = failures

			ciTurns++
			if ciTurns >= maxImplementTurnsPerWindow {
				return r.factoryExhausted(pr, fmt.Sprintf(
					"CI stayed red on %s for %d implement turns: this window's budget is exhausted", branch, ciTurns)), nil
			}
		}

		reviewTurn++
		reviewTurns++
		out, err := r.runFactoryReviewTurn(ctx, stages, detail, prior, reviewTurn)
		if err != nil {
			return FactoryWorkTicketResult{Outcome: work.OutcomeFailed, Usage: r.usage, PullRequest: pr}, err
		}
		prior[work.StageReview] = append(prior[work.StageReview], out)

		rev, ok := out.Value().(work.ReviewOutput)
		if !ok {
			return FactoryWorkTicketResult{Outcome: work.OutcomeFailed, Usage: r.usage, PullRequest: pr},
				fmt.Errorf("review turn %d produced %T, not work.ReviewOutput", reviewTurn, out.Value())
		}
		blocking := rev.BlockingFindingIDs()

		if len(blocking) == 0 {
			return FactoryWorkTicketResult{Outcome: work.OutcomeProposed, Usage: r.usage, PullRequest: pr}, nil
		}

		if intersects(blocking, lastBlocking) {
			return r.factoryExhausted(pr, fmt.Sprintf(
				"review turn %d repeated a blocking finding review turn %d already raised: no progress", reviewTurn, reviewTurn-1)), nil
		}
		if reviewTurns >= maxReviewTurns {
			return r.factoryExhausted(pr, fmt.Sprintf(
				"review raised blocking findings on all %d of its allotted turns", reviewTurns)), nil
		}

		lastBlocking = blocking
	}
}

// factoryExhausted builds the counters'-backstop terminal result —
// ticketRun.exhausted's counterpart. There is no FullDetail here: unlike the
// GitHub pipeline, a declined Ticket-backed run has no pull request comment
// to post it to (ADR-0012 retires that write), so only the one-line Detail
// travels, into RecordRunEnd's Failure/Outcome rather than prose.
func (r *factoryTicketRun) factoryExhausted(pr work.PullRequest, detail string) FactoryWorkTicketResult {
	return FactoryWorkTicketResult{Outcome: work.OutcomeExhausted, Usage: r.usage, PullRequest: pr, Detail: detail}
}

// runFactoryPlanTurn runs the plan stage's one and only turn.
func (r *factoryTicketRun) runFactoryPlanTurn(
	ctx, stages workflow.Context, detail work.TicketDetail, prior map[work.Stage][]work.StageOutput,
) (work.StageOutput, error) {
	const turn = 1
	startedAt := workflow.Now(ctx)
	model := r.in.Config.ModelFor(work.StagePlan)
	key := work.StageKey{Ticket: int(r.in.TicketID), RunID: r.runID, Stage: work.StagePlan, Turn: turn}
	r.recordStep(ctx, key)

	attempt := activities.StageAttempt{Key: key, Sandbox: r.sandbox, Model: model, Detail: detail, Prior: narrowPrior(prior)}
	if r.agentWorkflow {
		out, err := r.runAgentStage(ctx, attempt, agent.ToolsetCodingReadV1)
		if err != nil {
			r.recordAttempt(ctx, key, model, startedAt, out.Usage, out.UsageMeasured, store.AttemptFailed)
			return work.StageOutput{}, err
		}
		r.usage = r.usage.Add(out.Usage)
		r.recordAttempt(ctx, key, model, startedAt, out.Usage, out.UsageMeasured, store.AttemptSucceeded)
		r.persistAgentTranscript(ctx, key, out.TranscriptRef)
		return out.Result, nil
	}

	var out activities.RunPlanOutput
	if err := workflow.ExecuteActivity(stages, legacyRunPlanActivityName, activities.NewRunPlanInput(attempt)).Get(ctx, &out); err != nil {
		r.recordAttempt(ctx, key, model, startedAt, out.Usage, stageUsageAlwaysMeasured, store.AttemptFailed)
		return work.StageOutput{}, err
	}

	r.usage = r.usage.Add(out.Usage)
	// recordAttempt before persistTranscript: transcript's foreign key
	// requires the attempt row to already exist (see persistTranscript's own
	// doc comment on why the reverse order is a schema violation, not a
	// swallowed failure worth tolerating).
	r.recordAttempt(ctx, key, model, startedAt, out.Usage, stageUsageAlwaysMeasured, store.AttemptSucceeded)
	r.persistTranscript(ctx, key, out.Transcript)
	return out.Result, nil
}

// runFactoryImplementTurn runs one turn of the implement loop, turn
// 1-indexed across the whole run — WorkTicket's runImplementTurn, recording
// into Postgres instead of a status comment.
func (r *factoryTicketRun) runFactoryImplementTurn(
	ctx, stages workflow.Context, detail work.TicketDetail, prior map[work.Stage][]work.StageOutput, turn int,
) (work.StageOutput, error) {
	startedAt := workflow.Now(ctx)
	model := r.in.Config.ModelFor(work.StageImplement)
	key := work.StageKey{Ticket: int(r.in.TicketID), RunID: r.runID, Stage: work.StageImplement, Turn: turn}
	r.recordStep(ctx, key)

	attempt := activities.StageAttempt{Key: key, Sandbox: r.sandbox, Model: model, Detail: detail, Prior: narrowPrior(prior)}
	if r.agentWorkflow {
		out, err := r.runAgentStage(ctx, attempt, agent.ToolsetCodingWriteV1)
		if err != nil {
			r.recordAttempt(ctx, key, model, startedAt, out.Usage, out.UsageMeasured, store.AttemptFailed)
			return work.StageOutput{}, err
		}
		r.usage = r.usage.Add(out.Usage)
		r.recordAttempt(ctx, key, model, startedAt, out.Usage, out.UsageMeasured, store.AttemptSucceeded)
		r.persistAgentTranscript(ctx, key, out.TranscriptRef)
		return out.Result, nil
	}

	var out activities.RunImplementOutput
	if err := workflow.ExecuteActivity(stages, legacyRunImplementActivityName, activities.NewRunImplementInput(attempt)).Get(ctx, &out); err != nil {
		r.recordAttempt(ctx, key, model, startedAt, out.Usage, stageUsageAlwaysMeasured, store.AttemptFailed)
		return work.StageOutput{}, err
	}

	r.usage = r.usage.Add(out.Usage)
	// recordAttempt before persistTranscript: see runFactoryPlanTurn's
	// comment on the same ordering.
	r.recordAttempt(ctx, key, model, startedAt, out.Usage, stageUsageAlwaysMeasured, store.AttemptSucceeded)
	r.persistTranscript(ctx, key, out.Transcript)
	return out.Result, nil
}

// runFactoryReviewTurn runs one turn of the review loop, turn 1-indexed
// across the whole run.
func (r *factoryTicketRun) runFactoryReviewTurn(
	ctx, stages workflow.Context, detail work.TicketDetail, prior map[work.Stage][]work.StageOutput, turn int,
) (work.StageOutput, error) {
	startedAt := workflow.Now(ctx)
	model := r.in.Config.ModelFor(work.StageReview)
	key := work.StageKey{Ticket: int(r.in.TicketID), RunID: r.runID, Stage: work.StageReview, Turn: turn}
	r.recordStep(ctx, key)

	attempt := activities.StageAttempt{Key: key, Sandbox: r.sandbox, Model: model, Detail: detail, Prior: narrowPrior(prior)}
	if r.agentWorkflow {
		out, err := r.runAgentStage(ctx, attempt, agent.ToolsetCodingReadV1)
		if err != nil {
			r.recordAttempt(ctx, key, model, startedAt, out.Usage, out.UsageMeasured, store.AttemptFailed)
			return work.StageOutput{}, err
		}
		r.usage = r.usage.Add(out.Usage)
		r.recordAttempt(ctx, key, model, startedAt, out.Usage, out.UsageMeasured, store.AttemptSucceeded)
		r.persistAgentTranscript(ctx, key, out.TranscriptRef)
		return out.Result, nil
	}

	var out activities.RunReviewOutput
	if err := workflow.ExecuteActivity(stages, legacyRunReviewActivityName, activities.NewRunReviewInput(attempt)).Get(ctx, &out); err != nil {
		r.recordAttempt(ctx, key, model, startedAt, out.Usage, stageUsageAlwaysMeasured, store.AttemptFailed)
		return work.StageOutput{}, err
	}

	r.usage = r.usage.Add(out.Usage)
	// recordAttempt before persistTranscript: see runFactoryPlanTurn's
	// comment on the same ordering.
	r.recordAttempt(ctx, key, model, startedAt, out.Usage, stageUsageAlwaysMeasured, store.AttemptSucceeded)
	r.persistTranscript(ctx, key, out.Transcript)
	return out.Result, nil
}

func (r *factoryTicketRun) runAgentStage(
	ctx workflow.Context,
	attempt activities.StageAttempt,
	toolsetID agent.ToolsetID,
) (AgentWorkflowResult, error) {
	child := workflow.WithChildOptions(ctx, agentChildWorkflowOptions(r.in.Policy, attempt.Key))
	input := AgentWorkflowInput{
		Attempt: attempt, ToolsetID: toolsetID,
		ToolTarget: agent.ToolTarget{Kind: agent.ToolTargetLegacySandbox}, Limits: agent.DefaultLimits(),
		CacheKey: fmt.Sprintf("agent/%s/%s", r.runID, attempt.Key.Stage),
	}
	var result AgentWorkflowResult
	err := workflow.ExecuteChildWorkflow(child, AgentWorkflow, input).Get(ctx, &result)
	return result, err
}

func agentChildWorkflowOptions(policy work.RunPolicy, key work.StageKey) workflow.ChildWorkflowOptions {
	return workflow.ChildWorkflowOptions{
		WorkflowID:               agent.WorkflowID(key.RunID, string(key.Stage), key.Turn),
		WorkflowExecutionTimeout: policy.StageTimeout,
		WaitForCancellation:      true,
		ParentClosePolicy:        enums.PARENT_CLOSE_POLICY_REQUEST_CANCEL,
	}
}

// openOrUpdatePullRequest mirrors ticketRun.openOrUpdatePullRequest exactly;
// see its doc comment for the FindPullRequest-every-time reasoning.
func (r *factoryTicketRun) openOrUpdatePullRequest(
	control workflow.Context, branch, title, body string, existing work.PullRequest,
) (work.PullRequest, error) {
	var found activities.FindPullRequestOutput
	if err := workflow.ExecuteActivity(control, acts.FindPullRequest, branch).Get(control, &found); err != nil {
		return work.PullRequest{}, err
	}

	var existingArg *work.PullRequest
	if found.Found {
		existingArg = &found.PullRequest
	} else if existing.NodeID != "" {
		existingArg = &existing
	}

	in := activities.OpenOrUpdatePullRequestInput{Branch: branch, Title: title, Body: body, Existing: existingArg}
	var pr work.PullRequest
	if err := workflow.ExecuteActivity(control, acts.OpenOrUpdatePullRequest, in).Get(control, &pr); err != nil {
		return work.PullRequest{}, err
	}
	return pr, nil
}

// observeCI mirrors ticketRun.observeCI exactly.
func (r *factoryTicketRun) observeCI(ci workflow.Context, branch string) (activities.ObserveCIOutput, error) {
	in := activities.ObserveCIInput{Branch: branch, Bound: r.in.Policy.StageTimeout}
	var out activities.ObserveCIOutput
	err := workflow.ExecuteActivity(ci, acts.ObserveCI, in).Get(ci, &out)
	return out, err
}
