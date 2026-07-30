package workflows

import (
	"fmt"
	"strings"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// implementReviewLoop is the pipeline rewrite's real subject (ticket #435):
// plan has already run once by the time this is called; this runs implement
// and review in a loop bounded by two counters and, before either counter
// backstop fires, by progress detection — the same failing CI check or the
// same blocking review finding surviving an intervening turn.
//
// The turn-by-turn walk, matching the pipeline-rewrite spec's "The turn
// schedule" precisely (it is numbered there so two implementers could not
// build a different machine from the same prose, and this is written to the
// same numbering):
//
//  1. Enter a CI window: run implement, then observe CI for the branch it
//     pushed.
//     - Red, or unobserved past ObserveCI's own bound: increment ci_turns. At
//     5 (maxImplementTurnsPerWindow — 5 TOTAL attempts, not 5 retries after
//     a free first one), terminate exhausted with no review this window.
//     Otherwise, another implement turn in the same window.
//     - Green: reset ci_turns to 0. Leave the window, go to review.
//  2. Run review (consumes one of review_turns' three uses; never resets).
//     - No blocking findings: terminate, success.
//     - Blocking findings, and review_turns has now reached 3: terminate
//     exhausted, no fourth window.
//     - Blocking findings, review_turns below 3: a fresh CI window,
//     ci_turns already 0 from this window's own green.
//
// Progress detection (rule 1 on CI, rule 2 on review findings) is checked at
// the point each window/review concludes and can terminate the run before
// either counter backstop — the schedule above is what the counters count,
// not a replacement for those checks. Rule 3 (a blocked verdict) is checked
// ahead of all of it, the moment implement returns.
//
// implementTurn counts every implement invocation across the whole run
// (1-indexed, not reset per window) — "implement, turn 3 of 15" in a status
// comment, and the number StageKey.Turn carries. reviewTurn does the same for
// review.
func (r *ticketRun) implementReviewLoop(
	ctx workflow.Context,
	control, stages, ci workflow.Context,
	detail work.TicketDetail,
	prior map[work.Stage][]work.StageOutput,
) (WorkTicketResult, error) {
	branch := work.BranchName(r.in.Ticket.Number, r.runID)

	var (
		implementTurn int
		reviewTurn    int
		ciTurns       int
		reviewTurns   int
		lastRed       []string // the last CI-observed turn's red check names, carried forward across an unobserved turn — never reset to empty by one.
		lastBlocking  []string // the previous review turn's blocking finding ids.
		pr            work.PullRequest
	)

	for {
		for { // one CI window
			implementTurn++
			out, err := r.runImplementTurn(ctx, stages, detail, prior, implementTurn)
			if err != nil {
				return WorkTicketResult{Outcome: work.OutcomeFailed, Usage: r.usage, PullRequest: pr}, err
			}
			prior[work.StageImplement] = append(prior[work.StageImplement], out)

			impl, ok := out.Value().(work.ImplementOutput)
			if !ok {
				return WorkTicketResult{Outcome: work.OutcomeFailed, Usage: r.usage, PullRequest: pr},
					fmt.Errorf("implement turn %d produced %T, not work.ImplementOutput", implementTurn, out.Value())
			}

			// Rule 3: a blocked verdict stops immediately, ahead of the
			// CI/review machinery and either counter, whatever budget is
			// left.
			if impl.Blocked {
				return WorkTicketResult{
					Outcome: work.OutcomeBlocked, Usage: r.usage, PullRequest: pr,
					Detail:     impl.BlockedReason,
					FullDetail: fullDeclineDetail(impl.BlockedReason, prior),
				}, nil
			}

			updated, err := r.openOrUpdatePullRequest(control, branch, impl.Title, impl.Body, pr)
			if err != nil {
				return WorkTicketResult{Outcome: work.OutcomeFailed, Usage: r.usage, PullRequest: pr}, err
			}
			pr = updated

			obs, err := r.observeCI(ci, branch)
			if err != nil {
				return WorkTicketResult{Outcome: work.OutcomeFailed, Usage: r.usage, PullRequest: pr}, err
			}

			if !obs.Concluded {
				// Unobserved counts as red against ci_turns — an unknown CI
				// outcome must not be free progress — but is invisible to
				// rule 1's comparison: lastRed is not touched, so the next
				// actually-observed red turn compares against whatever was
				// last seen, however many turns back that was.
				ciTurns++
				if ciTurns >= maxImplementTurnsPerWindow {
					return r.exhausted(pr, prior, fmt.Sprintf(
						"CI did not conclude for %s within %d implement turns in this window", branch, ciTurns)), nil
				}
				continue
			}

			if obs.Green {
				ciTurns = 0
				lastRed = nil
				break // leave the CI window, go to review
			}

			// Red. Rule 1, before the counter: the same failing check(s)
			// held across an intervening implement turn, with nothing new
			// having appeared, is terminal on its own, even with budget left.
			if len(obs.RedChecks) > 0 && isSubsetOf(obs.RedChecks, lastRed) {
				return r.exhausted(pr, prior, fmt.Sprintf(
					"CI failed the same check(s) (%s) on %s as the previous observed turn: no progress",
					strings.Join(obs.RedChecks, ", "), branch)), nil
			}
			lastRed = obs.RedChecks

			ciTurns++
			if ciTurns >= maxImplementTurnsPerWindow {
				return r.exhausted(pr, prior, fmt.Sprintf(
					"CI stayed red on %s for %d implement turns: this window's budget is exhausted", branch, ciTurns)), nil
			}
		}

		reviewTurn++
		reviewTurns++ // never resets
		out, err := r.runReviewTurn(ctx, stages, detail, prior, reviewTurn)
		if err != nil {
			return WorkTicketResult{Outcome: work.OutcomeFailed, Usage: r.usage, PullRequest: pr}, err
		}
		prior[work.StageReview] = append(prior[work.StageReview], out)

		rev, ok := out.Value().(work.ReviewOutput)
		if !ok {
			return WorkTicketResult{Outcome: work.OutcomeFailed, Usage: r.usage, PullRequest: pr},
				fmt.Errorf("review turn %d produced %T, not work.ReviewOutput", reviewTurn, out.Value())
		}
		blocking := rev.BlockingFindingIDs()

		if len(blocking) == 0 {
			return WorkTicketResult{Outcome: work.OutcomeProposed, Usage: r.usage, PullRequest: pr}, nil
		}

		// Rule 2, before the counter: the same blocking finding id surviving
		// an intervening implement turn is terminal on its own.
		if intersects(blocking, lastBlocking) {
			return r.exhausted(pr, prior, fmt.Sprintf(
				"review turn %d repeated a blocking finding review turn %d already raised: no progress", reviewTurn, reviewTurn-1)), nil
		}

		if reviewTurns >= maxReviewTurns {
			return r.exhausted(pr, prior, fmt.Sprintf(
				"review raised blocking findings on all %d of its allotted turns", reviewTurns)), nil
		}

		lastBlocking = blocking
		// ciTurns is already 0, carried from this window's own green; a
		// fresh CI window opens.
	}
}

// exhausted builds the counters'-backstop terminal result: the loop tried,
// genuinely made no further progress or ran out of budget, and never
// reached approval. Distinct from OutcomeBlocked, which is implement's own
// explicit verdict rather than a backstop firing — see work.OutcomeExhausted.
func (r *ticketRun) exhausted(pr work.PullRequest, prior map[work.Stage][]work.StageOutput, detail string) WorkTicketResult {
	return WorkTicketResult{
		Outcome: work.OutcomeExhausted, Usage: r.usage, PullRequest: pr,
		Detail: detail, FullDetail: fullDeclineDetail(detail, prior),
	}
}

// fullDeclineDetail renders the prose worth posting as a declined run's own
// pull request comment: why the loop stopped, the plan it was working from,
// and the most recent review's findings if review ever ran. It reads out of
// the same turn history the loop already carries in workflow state — no new
// activity call, nothing beyond what prior already holds.
func fullDeclineDetail(reason string, prior map[work.Stage][]work.StageOutput) string {
	var b strings.Builder
	fmt.Fprintf(&b, "**Why the loop stopped**\n\n%s\n", reason)

	if plan := lastOutput(prior[work.StagePlan]); plan.Prose() != "" {
		fmt.Fprintf(&b, "\n**Plan**\n\n%s\n", plan.Prose())
	}

	if review, ok := lastOutput(prior[work.StageReview]).Value().(work.ReviewOutput); ok && len(review.Findings) > 0 {
		b.WriteString("\n**Most recent review findings**\n\n")
		for _, f := range review.Findings {
			kind := "advisory"
			if f.Blocking {
				kind = "blocking"
			}
			fmt.Fprintf(&b, "- id=%s (%s): %s\n", f.ID, kind, f.Summary)
		}
	}

	return b.String()
}

// lastOutput returns the most recent output in a stage's turn history, or
// the zero work.StageOutput if the stage has not produced one yet.
func lastOutput(outputs []work.StageOutput) work.StageOutput {
	if len(outputs) == 0 {
		return work.StageOutput{}
	}
	return outputs[len(outputs)-1]
}

// runPlanTurn runs the plan stage's one and only turn.
func (r *ticketRun) runPlanTurn(
	ctx, stages workflow.Context, detail work.TicketDetail, prior map[work.Stage][]work.StageOutput,
) (work.StageOutput, error) {
	const turn = 1
	startedAt := workflow.Now(ctx)
	model := r.in.Config.ModelFor(work.StagePlan)
	r.report(ctx, work.StatusReport{
		Step: work.StageStep(work.StagePlan), State: work.StepRunning,
		Stage: work.StagePlan, Model: model, StartedAt: startedAt,
	})

	attempt := activities.StageAttempt{
		Key:     work.StageKey{Ticket: r.in.Ticket.Number, RunID: r.runID, Stage: work.StagePlan, Turn: turn},
		Sandbox: r.sandbox,
		Model:   model,
		Detail:  detail,
		Prior:   prior,
	}

	var out activities.RunPlanOutput
	if err := workflow.ExecuteActivity(stages, acts.RunPlan, activities.NewRunPlanInput(attempt)).Get(ctx, &out); err != nil {
		r.report(ctx, work.StatusReport{
			Step: work.StageStep(work.StagePlan), State: work.StepFailed,
			Stage: work.StagePlan, Model: model, StartedAt: startedAt, EndedAt: workflow.Now(ctx),
			Usage: out.Usage, Detail: stageFailureDetail(err),
		})
		return work.StageOutput{}, err
	}

	r.usage = r.usage.Add(out.Usage)
	r.persistTranscript(ctx, attempt.Key, out.Transcript)
	r.report(ctx, work.StatusReport{
		Step: work.StageStep(work.StagePlan), State: work.StepSucceeded,
		Stage: work.StagePlan, Model: model, StartedAt: startedAt, EndedAt: workflow.Now(ctx),
		Usage: out.Usage,
	})
	return out.Result, nil
}

// runImplementTurn runs one turn of the implement loop, turn 1-indexed
// across the whole run. The status comment it posts to is the one
// "stage-implement" comment every turn of this run shares, edited in place —
// the same one-comment-per-step convention the pipeline already used before
// this step, now also spanning turns of the same stage.
func (r *ticketRun) runImplementTurn(
	ctx, stages workflow.Context, detail work.TicketDetail, prior map[work.Stage][]work.StageOutput, turn int,
) (work.StageOutput, error) {
	startedAt := workflow.Now(ctx)
	model := r.in.Config.ModelFor(work.StageImplement)
	r.report(ctx, work.StatusReport{
		Step: work.StageStep(work.StageImplement), State: work.StepRunning,
		Stage: work.StageImplement, Model: model, StartedAt: startedAt,
	})

	attempt := activities.StageAttempt{
		Key:     work.StageKey{Ticket: r.in.Ticket.Number, RunID: r.runID, Stage: work.StageImplement, Turn: turn},
		Sandbox: r.sandbox,
		Model:   model,
		Detail:  detail,
		Prior:   prior,
	}

	var out activities.RunImplementOutput
	if err := workflow.ExecuteActivity(stages, acts.RunImplement, activities.NewRunImplementInput(attempt)).Get(ctx, &out); err != nil {
		r.report(ctx, work.StatusReport{
			Step: work.StageStep(work.StageImplement), State: work.StepFailed,
			Stage: work.StageImplement, Model: model, StartedAt: startedAt, EndedAt: workflow.Now(ctx),
			Usage: out.Usage, Detail: stageFailureDetail(err),
		})
		return work.StageOutput{}, err
	}

	r.usage = r.usage.Add(out.Usage)
	r.persistTranscript(ctx, attempt.Key, out.Transcript)
	r.report(ctx, work.StatusReport{
		Step: work.StageStep(work.StageImplement), State: work.StepSucceeded,
		Stage: work.StageImplement, Model: model, StartedAt: startedAt, EndedAt: workflow.Now(ctx),
		Usage: out.Usage,
	})
	return out.Result, nil
}

// runReviewTurn runs one turn of the review loop, turn 1-indexed across the
// whole run — a separate counter from implement's, since the two loop
// independently (one review turn per CI window that reaches green).
func (r *ticketRun) runReviewTurn(
	ctx, stages workflow.Context, detail work.TicketDetail, prior map[work.Stage][]work.StageOutput, turn int,
) (work.StageOutput, error) {
	startedAt := workflow.Now(ctx)
	model := r.in.Config.ModelFor(work.StageReview)
	r.report(ctx, work.StatusReport{
		Step: work.StageStep(work.StageReview), State: work.StepRunning,
		Stage: work.StageReview, Model: model, StartedAt: startedAt,
	})

	attempt := activities.StageAttempt{
		Key:     work.StageKey{Ticket: r.in.Ticket.Number, RunID: r.runID, Stage: work.StageReview, Turn: turn},
		Sandbox: r.sandbox,
		Model:   model,
		Detail:  detail,
		Prior:   prior,
	}

	var out activities.RunReviewOutput
	if err := workflow.ExecuteActivity(stages, acts.RunReview, activities.NewRunReviewInput(attempt)).Get(ctx, &out); err != nil {
		r.report(ctx, work.StatusReport{
			Step: work.StageStep(work.StageReview), State: work.StepFailed,
			Stage: work.StageReview, Model: model, StartedAt: startedAt, EndedAt: workflow.Now(ctx),
			Usage: out.Usage, Detail: stageFailureDetail(err),
		})
		return work.StageOutput{}, err
	}

	r.usage = r.usage.Add(out.Usage)
	r.persistTranscript(ctx, attempt.Key, out.Transcript)
	r.report(ctx, work.StatusReport{
		Step: work.StageStep(work.StageReview), State: work.StepSucceeded,
		Stage: work.StageReview, Model: model, StartedAt: startedAt, EndedAt: workflow.Now(ctx),
		Usage: out.Usage,
	})
	return out.Result, nil
}

// openOrUpdatePullRequest asks GitHub what is open on this run's branch and
// creates or edits its pull request to match implement's latest title and
// body.
//
// This is PR ownership as code, not the model (#435's locked decision): a
// pull request opens after the FIRST successful push and is never held back
// waiting for CI or review to conclude, so a human watching the ticket sees
// a diff the moment there is one. existing is the zero work.PullRequest
// before the first push; FindPullRequest is still asked every time rather
// than trusted from a previous call's return, because it is what makes "did
// GitHub actually keep what we last wrote" a fact this asks for rather than
// assumes.
func (r *ticketRun) openOrUpdatePullRequest(
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
		// FindPullRequest not finding it this time despite an earlier
		// success is not expected, but if it happens, the last value this
		// run itself successfully wrote is a better existing-state guess
		// than treating this push as the very first one and trying Create
		// again.
		existingArg = &existing
	}

	in := activities.OpenOrUpdatePullRequestInput{Branch: branch, Title: title, Body: body, Existing: existingArg}
	var pr work.PullRequest
	if err := workflow.ExecuteActivity(control, acts.OpenOrUpdatePullRequest, in).Get(control, &pr); err != nil {
		return work.PullRequest{}, err
	}
	return pr, nil
}

// observeCI asks whether CI has concluded for branch, within ObserveCI's own
// poll bound.
func (r *ticketRun) observeCI(ci workflow.Context, branch string) (activities.ObserveCIOutput, error) {
	in := activities.ObserveCIInput{Branch: branch, Bound: r.observeCIBound()}
	var out activities.ObserveCIOutput
	err := workflow.ExecuteActivity(ci, acts.ObserveCI, in).Get(ci, &out)
	return out, err
}

// observeCIBound is how long ObserveCI itself polls before giving up and
// reporting itself unobserved — sized one rung below ciOptions'
// StartToCloseTimeout, with margin, so it returns that normal result
// gracefully rather than being cancelled by Temporal first.
func (r *ticketRun) observeCIBound() time.Duration {
	return r.in.Policy.StageTimeout
}

// ciOptions govern the CI-observation activity: it does no model work and
// touches no sandbox, so it runs on the MAIN task queue like the control
// activities rather than inside the run's Session — but its own poll loop
// can legitimately take as long as observeCIBound, which controlOptions'
// short ControlTimeout cannot hold, so it gets its own, generous
// StartToCloseTimeout instead: one stage timeout's worth of polling plus
// headroom for ObserveCI to return its own "unobserved" result before
// Temporal would otherwise cancel it.
func (r *ticketRun) ciOptions() workflow.ActivityOptions {
	return workflow.ActivityOptions{
		StartToCloseTimeout: r.observeCIBound() + 5*time.Minute,
		HeartbeatTimeout:    r.in.Policy.StageHeartbeatTimeout,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: r.in.Policy.ControlAttempts},
	}
}
