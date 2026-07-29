package status_test

import (
	"strings"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/status"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// TestRendererDispatchesEachStatusReportShape locks the mapping the
// composition root depends on: activities.StatusRenderer is satisfied by
// *status.Renderer, and a report reaching it as one of the six shapes this
// package renders produces the same body the underlying type would.
func TestRendererDispatchesEachStatusReportShape(t *testing.T) {
	t.Parallel()

	renderer := status.NewRenderer("", "")
	startedAt := time.Date(2026, 7, 28, 18, 4, 7, 0, time.UTC)
	endedAt := time.Date(2026, 7, 28, 18, 7, 19, 0, time.UTC)
	usage := work.Usage{InputTokens: 100, OutputTokens: 50}

	cases := map[string]struct {
		report work.StatusReport
		want   string
	}{
		"pickup": {
			report: work.StatusReport{
				TicketNumber: 331, RunID: "run-1", Step: work.StepPickup,
				State: work.StepRunning, StartedAt: startedAt,
			},
			want: status.Pickup{RunID: "run-1", StartedAt: startedAt}.Body(),
		},
		"stage started": {
			report: work.StatusReport{
				TicketNumber: 331, RunID: "run-1", Step: work.StageStep(work.StagePlan),
				State: work.StepRunning, Stage: work.StagePlan, Model: work.Model{Name: "gpt-5-codex"},
				StartedAt: startedAt,
			},
			want: status.StageStarted{
				RunID: "run-1", Stage: work.StagePlan, Model: work.Model{Name: "gpt-5-codex"},
				StartedAt: startedAt,
			}.Body(),
		},
		"stage succeeded": {
			report: work.StatusReport{
				TicketNumber: 331, RunID: "run-1", Step: work.StageStep(work.StagePlan),
				State: work.StepSucceeded, Stage: work.StagePlan, Model: work.Model{Name: "gpt-5-codex"},
				StartedAt: startedAt, EndedAt: endedAt, Usage: usage,
			},
			want: status.StageSucceeded{
				RunID: "run-1", Stage: work.StagePlan, Model: work.Model{Name: "gpt-5-codex"},
				StartedAt: startedAt, EndedAt: endedAt, Usage: usage,
			}.Body(),
		},
		"stage failed": {
			report: work.StatusReport{
				TicketNumber: 331, RunID: "run-1", Step: work.StageStep(work.StagePlan),
				State: work.StepFailed, Stage: work.StagePlan, Model: work.Model{Name: "gpt-5-codex"},
				StartedAt: startedAt, EndedAt: endedAt, Usage: usage, Detail: "exit 1",
			},
			want: status.StageFailed{
				RunID: "run-1", Stage: work.StagePlan, Model: work.Model{Name: "gpt-5-codex"},
				StartedAt: startedAt, EndedAt: endedAt, Usage: usage, Reason: "exit 1",
			}.Body(),
		},
		"proposed": {
			report: work.StatusReport{
				TicketNumber: 331, RunID: "run-1", Step: work.StepOutcome,
				State: work.StepSucceeded, Outcome: work.OutcomeProposed, EndedAt: endedAt, Usage: usage,
				PullRequestURL: "https://github.com/o/r/pull/9",
			},
			want: status.Proposed{
				RunID: "run-1", EndedAt: endedAt, RunUsage: usage,
				PullRequestURL: "https://github.com/o/r/pull/9",
			}.Body(),
		},
		"abandoned": {
			report: work.StatusReport{
				TicketNumber: 331, RunID: "run-1", Step: work.StepOutcome,
				State: work.StepFailed, Outcome: work.OutcomeBlocked, EndedAt: endedAt, Usage: usage, Detail: "blocked",
			},
			want: status.Abandoned{RunID: "run-1", Reason: "blocked", EndedAt: endedAt, RunUsage: usage}.Body(),
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if got := renderer.Render(tc.report); got != tc.want {
				t.Errorf("Render(%s) = %q, want %q", name, got, tc.want)
			}
		})
	}
}

// TestRendererBuildsTheRunURLFromItsOrigin proves the one piece of the
// mapping the case table above cannot see: a renderer holding a UI origin
// links the run, and one holding none renders the run ID as plain text.
func TestRendererBuildsTheRunURLFromItsOrigin(t *testing.T) {
	t.Parallel()

	report := work.StatusReport{
		TicketNumber: 331, RunID: "019a3f2c-run", Step: work.StepPickup,
		State: work.StepRunning, StartedAt: time.Date(2026, 7, 28, 18, 4, 5, 0, time.UTC),
	}

	withOrigin := status.NewRenderer("https://temporal.example", "software-factory")
	body := withOrigin.Render(report)
	wantURL := "https://temporal.example/namespaces/software-factory/workflows/work-ticket-331/019a3f2c-run/history"
	if !strings.Contains(body, wantURL) {
		t.Errorf("Render() with a UI origin = %q, want it to contain the run URL %q", body, wantURL)
	}

	withoutOrigin := status.NewRenderer("", "")
	body = withoutOrigin.Render(report)
	if strings.Contains(body, "https://") {
		t.Errorf("Render() with no UI origin = %q, want no link", body)
	}
}

// TestRendererRefusesAnUnrecognisedStep guards against a silent empty body: a
// report this package does not know how to render says so in the body rather
// than posting a blank comment or crashing the activity delivering it.
func TestRendererRefusesAnUnrecognisedStep(t *testing.T) {
	t.Parallel()

	renderer := status.NewRenderer("", "")
	got := renderer.Render(work.StatusReport{Step: work.StatusStep("something-new")})
	if !strings.Contains(got, "something-new") {
		t.Errorf("Render() of an unrecognised step = %q, want it to name the step", got)
	}
}
