package status

import (
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// Renderer adapts a work.StatusReport to the comment types above, so it
// satisfies activities.StatusRenderer without this package importing
// internal/activities — the interface is consumer-side, and this is the
// implementation.
//
// It decides nothing about *whether* to post or edit a comment; that is
// GitHub's job, driven from the ReportStatus activity. It only decides which
// of Pickup, StageStarted, StageSucceeded, StageFailed, Proposed or Abandoned
// a report becomes, from fields the report already carries.
//
// #331 — what happens when a human deletes a status comment out from under a
// running ticket, repost or treat the run as done — is an open design
// question Calum has not answered. This type does not answer it either: the
// choice belongs in the activity that decides whether Comment == 0 means
// "post" or "the human deleted it, and this run is dead", not in the renderer
// that only turns a report into words. Keeping it out of here is deliberate,
// so either answer stays a small change in ReportStatus.
type Renderer struct {
	// RunURLBase is the Temporal Web UI's origin (scheme and host, no path),
	// or empty if none is public. Pickup.RunURL is built from it; empty
	// renders the run ID as plain text, which is what Pickup's own doc
	// comment says is the correct behaviour when there is nothing to link to.
	RunURLBase string

	// Namespace is the Temporal namespace the run's workflow lives in, needed
	// alongside RunURLBase to build the Web UI's path grammar.
	Namespace string
}

// NewRenderer builds a status renderer. runURLBase and namespace may both be
// empty; the run ID renders as plain text in that case.
func NewRenderer(runURLBase, namespace string) *Renderer {
	return &Renderer{RunURLBase: runURLBase, Namespace: namespace}
}

// Render turns one status report into the comment body it means.
func (r *Renderer) Render(report work.StatusReport) string {
	switch {
	case report.Stage != "":
		return r.renderStage(report)
	case report.Step == work.StepPickup:
		return Pickup{
			RunID:     report.RunID,
			RunURL:    r.runURL(report),
			StartedAt: report.StartedAt,
		}.Body()
	case report.Step == work.StepOutcome:
		return r.renderOutcome(report)
	default:
		// Every report this service produces sets Stage, or Step to pickup or
		// outcome — see work/status.go. Reaching this is a caller sending a
		// step this renderer does not know, which is a programming error
		// worth a legible comment rather than a panic that kills the
		// activity handling something a human is waiting to read.
		return fmt.Sprintf("### software-factory status\n\nunrecognised status step %q\n", report.Step)
	}
}

// renderStage handles the three bodies a stage's own comment can hold.
func (r *Renderer) renderStage(report work.StatusReport) string {
	switch report.State {
	case work.StepRunning:
		return StageStarted{
			RunID: report.RunID, Stage: report.Stage, Model: report.Model,
			StartedAt: report.StartedAt,
		}.Body()
	case work.StepSucceeded:
		return StageSucceeded{
			RunID: report.RunID, Stage: report.Stage, Model: report.Model,
			StartedAt: report.StartedAt, EndedAt: report.EndedAt, Usage: report.Usage,
		}.Body()
	case work.StepFailed:
		return StageFailed{
			RunID: report.RunID, Stage: report.Stage, Model: report.Model,
			StartedAt: report.StartedAt, EndedAt: report.EndedAt, Usage: report.Usage,
			Reason: report.Detail,
		}.Body()
	default:
		return fmt.Sprintf("### software-factory status\n\nunrecognised stage state %q\n", report.State)
	}
}

// renderOutcome handles the run's last comment: Proposed, Declined or
// Abandoned, depending on what the run achieved and whether it left a pull
// request behind.
//
// report.PullRequestURL is the URL GitHub's API returned for the run's own
// branch (#371), threaded through from work.WorkTicketResult.PullRequest in
// workflows.ticketRun.finish — never a value read out of a stage's own
// result file. Proposed.Body and Declined.Body still render it defensively
// (linkedURL, pullRequestHost): the field's provenance is trustworthy today,
// but the renderer does not get to assume that stays true.
func (r *Renderer) renderOutcome(report work.StatusReport) string {
	if report.Outcome == work.OutcomeProposed {
		return Proposed{
			RunID:          report.RunID,
			PullRequestURL: report.PullRequestURL,
			EndedAt:        report.EndedAt,
			RunUsage:       report.Usage,
		}.Body()
	}

	// A non-approval outcome still has a pull request to link once the loop's
	// terminal-cleanup sequence has run (#435): PR ownership is code now, so a
	// pull request opens after the first successful push, long before the
	// loop knows how it will end. Only OutcomeBlocked and OutcomeExhausted can
	// carry one — OutcomeFailed is an infra break the run never got far
	// enough to open anything for, and falls through to Abandoned below like
	// a decline that happened before any push did.
	if report.PullRequestURL != "" && (report.Outcome == work.OutcomeBlocked || report.Outcome == work.OutcomeExhausted) {
		return Declined{
			RunID:          report.RunID,
			Outcome:        report.Outcome,
			Reason:         report.Detail,
			PullRequestURL: report.PullRequestURL,
			EndedAt:        report.EndedAt,
			RunUsage:       report.Usage,
		}.Body()
	}

	return Abandoned{
		RunID:    report.RunID,
		Reason:   report.Detail,
		EndedAt:  report.EndedAt,
		RunUsage: report.Usage,
	}.Body()
}

// runURL builds the Temporal Web UI link for a report's run, or "" if this
// renderer has no public UI origin to build one from.
func (r *Renderer) runURL(report work.StatusReport) string {
	if r.RunURLBase == "" || r.Namespace == "" || report.RunID == "" {
		return ""
	}
	return fmt.Sprintf("%s/namespaces/%s/workflows/%s/%s/history",
		r.RunURLBase, r.Namespace, work.WorkflowID(report.TicketNumber), report.RunID)
}
