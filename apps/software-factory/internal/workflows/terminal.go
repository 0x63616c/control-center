package workflows

import (
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/sdk/workflow"
)

// declineDetail is everything the terminal-cleanup sequence needs to know
// about a non-approval ending, once the implement/review loop (or an earlier
// stage, for a decline that happens before anything is ever pushed) has
// decided it.
type declineDetail struct {
	// Outcome is work.OutcomeBlocked or work.OutcomeExhausted. Never
	// work.OutcomeProposed — a run that proposed does not go through decline
	// at all, see ticketRun.finish.
	Outcome work.Outcome

	// Detail is the one-line reason the outcome comment and the pull
	// request's own comment both carry.
	Detail string

	// PullRequest is the run's pull request, if the loop ever pushed anything.
	// The zero value means it never did — a decline reached before the first
	// push — and decline skips draft conversion and the pull request comment
	// entirely in that case, going straight to the label.
	PullRequest work.PullRequest

	// FullDetail is the prose to post as the pull request's own comment:
	// everything a reviewer would want to see (the plan, the review's
	// findings, why the loop stopped). Empty is a legitimate value — it means
	// nothing beyond the one-line Detail is worth repeating — and decline
	// then posts no pull request comment at all rather than an empty one.
	FullDetail string
}

// decline runs the ordered terminal-cleanup sequence for every non-approval
// ending: attempt to convert the pull request to draft, strip `auto`, then
// post the pull request's own detail comment. It never posts
// the one-line issue comment itself — that is r.report's existing
// work.StepOutcome path, called by ticketRun.finish before or after this, and
// unchanged by this step.
//
// Pull requests created after the draft-first rollout start as drafts, so the
// conversion stays a cheap idempotent safety net and cleanup can continue
// after its failure. A workflow that began before rollout may own a ready
// pull request, though; its reported Draft state keeps the legacy fail-closed
// behavior until conversion succeeds.
func (r *ticketRun) decline(ctx workflow.Context, d declineDetail) error {
	log := workflow.GetLogger(ctx)
	control := workflow.WithActivityOptions(ctx, r.controlOptions())

	// No pull request ever existed — a decline before the first push. There is
	// nothing to convert to draft and nothing to comment on; go straight to
	// the label.
	if d.PullRequest.NodeID == "" {
		if err := workflow.ExecuteActivity(control, acts.ClearAutoLabel, r.in.Ticket.Number).Get(ctx, nil); err != nil {
			log.Error("clearing the auto label failed; this ticket will be listed again",
				"ticket", r.in.Ticket.Number, "error", err)
		}
		return nil
	}

	if err := workflow.ExecuteActivity(control, acts.ConvertPullRequestToDraft, d.PullRequest.NodeID).Get(ctx, nil); err != nil {
		log.Error("converting the pull request to draft failed after every retry",
			"ticket", r.in.Ticket.Number, "pull_request", d.PullRequest.Number, "error", err)
		if !d.PullRequest.Draft {
			log.Error("the pull request may predate draft-first creation; the auto label stays on",
				"ticket", r.in.Ticket.Number, "pull_request", d.PullRequest.Number)
			r.postPullRequestComment(ctx, d)
			return fmt.Errorf("converting legacy ready pull request %s to draft: %w", d.PullRequest.URL, err)
		}
	}

	if err := workflow.ExecuteActivity(control, acts.ClearAutoLabel, r.in.Ticket.Number).Get(ctx, nil); err != nil {
		log.Error("clearing the auto label failed; this ticket will be listed again",
			"ticket", r.in.Ticket.Number, "error", err)
	}

	r.postPullRequestComment(ctx, d)
	return nil
}

// postPullRequestComment posts the pull request's full-detail comment,
// best-effort — a comment is additive and can never itself be mistaken for
// approval, so its failure is logged and absorbed like every other
// status-comment failure in this service.
func (r *ticketRun) postPullRequestComment(ctx workflow.Context, d declineDetail) {
	if d.PullRequest.Number == 0 || d.FullDetail == "" {
		return
	}
	control := workflow.WithActivityOptions(ctx, r.controlOptions())
	if err := workflow.ExecuteActivity(control, acts.PostPullRequestComment, d.PullRequest.Number, d.FullDetail).Get(ctx, nil); err != nil {
		workflow.GetLogger(ctx).Error("posting the pull request's full-detail comment failed",
			"ticket", r.in.Ticket.Number, "pull_request", d.PullRequest.Number, "error", err)
	}
}
