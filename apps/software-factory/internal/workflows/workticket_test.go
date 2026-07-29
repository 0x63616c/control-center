package workflows_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
	"github.com/stretchr/testify/mock"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
)

// acts is a nil handle used only to name activity methods for the test
// environment's mocks. Nothing is ever called on it.
var acts *activities.Activities

const dispatcherID = "software-factory-dispatcher"

// stageOutput is what a happy pipeline returns, one distinct value per stage,
// so a test can follow the handoff chain by identity rather than by shape.
func stageOutput(stage work.Stage) activities.RunStageOutput {
	out := activities.RunStageOutput{
		Output:   []byte(fmt.Sprintf(`{"from":%q}`, stage)),
		ThreadID: "thread-" + string(stage),
		Usage:    work.Usage{InputTokens: 10, OutputTokens: 1},
	}
	if stage == work.StagePropose {
		out.Verdict = work.StageVerdict{PullRequest: "https://github.com/o/r/pull/9"}
	}
	return out
}

// ticketHarness runs one WorkTicket workflow against fakes and records what it
// did. Knobs are set before run; everything else is a successful pipeline.
type ticketHarness struct {
	env *testsuite.TestWorkflowEnvironment

	// knobs.
	policy     work.RunPolicy
	config     work.Config
	stage      func(in activities.RunStageInput) (activities.RunStageOutput, error)
	stageDelay time.Duration
	labelErr   error
	cancelAt   time.Duration

	// what the run did.
	ran      []work.Stage
	handoffs map[work.Stage]string
	models   map[work.Stage]work.Model
	keys     map[work.Stage]work.StageKey
	created  int
	deleted  []work.SandboxID
	cleared  int
	reports  []work.StatusReport
	done     work.TicketDone
}

func newTicketHarness(t *testing.T) *ticketHarness {
	t.Helper()
	suite := &testsuite.WorkflowTestSuite{}
	return &ticketHarness{
		env:      suite.NewTestWorkflowEnvironment(),
		policy:   work.DefaultRunPolicy(),
		config:   work.DefaultConfig(),
		handoffs: map[work.Stage]string{},
		models:   map[work.Stage]work.Model{},
		keys:     map[work.Stage]work.StageKey{},
	}
}

func (h *ticketHarness) run() {
	env := h.env

	env.OnActivity(acts.FetchTicketDetail, mock.Anything, 328).
		Return(work.TicketDetail{Ticket: work.Ticket{Number: 328, Title: "a ticket", Body: "do the thing"}}, nil)

	env.OnActivity(acts.ReportStatus, mock.Anything, mock.Anything).
		Return(func(_ context.Context, report work.StatusReport) (work.CommentID, error) {
			h.reports = append(h.reports, report)
			return 77, nil
		})

	env.OnActivity(acts.CreateSandbox, mock.Anything, mock.Anything).
		Return(func(_ context.Context, _ activities.CreateSandboxInput) (work.SandboxID, error) {
			h.created++
			return "sandbox-328", nil
		})

	env.OnActivity(acts.WaitSandboxReady, mock.Anything, mock.Anything).Return(nil)

	env.OnActivity(acts.DeleteSandbox, mock.Anything, mock.Anything).
		Return(func(_ context.Context, id work.SandboxID) error {
			h.deleted = append(h.deleted, id)
			return nil
		})

	env.OnActivity(acts.ClearAutoLabel, mock.Anything, 328).
		Return(func(_ context.Context, _ int) error {
			h.cleared++
			return h.labelErr
		})

	stage := env.OnActivity(acts.RunStage, mock.Anything, mock.Anything)
	if h.stageDelay > 0 {
		stage = stage.After(h.stageDelay)
	}
	stage.Return(func(_ context.Context, in activities.RunStageInput) (activities.RunStageOutput, error) {
		h.ran = append(h.ran, in.Key.Stage)
		h.handoffs[in.Key.Stage] = string(in.Handoff)
		h.models[in.Key.Stage] = in.Model
		h.keys[in.Key.Stage] = in.Key
		if h.stage != nil {
			return h.stage(in)
		}
		return stageOutput(in.Key.Stage), nil
	})

	env.OnSignalExternalWorkflow(mock.Anything, dispatcherID, mock.Anything, workflows.SignalTicketDone, mock.Anything).
		Return(func(_, _, _, _ string, arg any) error {
			h.done = arg.(work.TicketDone)
			return nil
		})

	if h.cancelAt > 0 {
		env.RegisterDelayedCallback(env.CancelWorkflow, h.cancelAt)
	}

	env.ExecuteWorkflow(workflows.WorkTicket, workflows.WorkTicketInput{
		Ticket:       work.Ticket{Number: 328, Title: "a ticket", Body: "do the thing"},
		Config:       h.config,
		Policy:       h.policy,
		DispatcherID: dispatcherID,
	})
}

func (h *ticketHarness) result(t *testing.T) workflows.WorkTicketResult {
	t.Helper()
	var result workflows.WorkTicketResult
	if err := h.env.GetWorkflowResult(&result); err != nil {
		t.Fatalf("workflow result: %v", err)
	}
	return result
}

// failingStage is a stage that dies the way a wedged codex process does.
func failingStage(activities.RunStageInput) (activities.RunStageOutput, error) {
	return activities.RunStageOutput{},
		temporal.NewNonRetryableApplicationError("exit 1", activities.ErrTypePermanent, nil)
}

func TestWorkTicketRunsTheFiveStagesInPipelineOrder(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.run()

	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow: %v", err)
	}
	want := work.Pipeline()
	if len(h.ran) != len(want) {
		t.Fatalf("ran %v, want %v", h.ran, want)
	}
	for i := range want {
		if h.ran[i] != want[i] {
			t.Fatalf("ran %v, want %v", h.ran, want)
		}
	}
}

func TestWorkTicketFeedsEachStageThePrecedingStagesOutput(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.run()

	if got := h.handoffs[work.StagePlan]; got != "" {
		t.Fatalf("the first stage has nothing to hand off from, got %q", got)
	}
	for _, pair := range [][2]work.Stage{
		{work.StagePlan, work.StageReview},
		{work.StageReview, work.StageRevise},
		{work.StageRevise, work.StageImplement},
		{work.StageImplement, work.StagePropose},
	} {
		want := string(stageOutput(pair[0]).Output)
		if got := h.handoffs[pair[1]]; got != want {
			t.Fatalf("%s received %q, want %s's output %q", pair[1], got, pair[0], want)
		}
	}
}

func TestWorkTicketTotalsTheTokensEveryStageSpent(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.run()

	result := h.result(t)
	if result.Usage.InputTokens != 50 || result.Usage.OutputTokens != 5 {
		t.Fatalf("usage = %+v, want the sum of five stages", result.Usage)
	}
}

func TestWorkTicketReportsTheProposedPullRequest(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.run()

	result := h.result(t)
	if result.Outcome != work.OutcomeProposed || result.PullRequest == "" {
		t.Fatalf("result = %+v, want a proposed pull request", result)
	}
}

func TestWorkTicketFailsWhenProposeOpensNoPullRequest(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.stage = func(in activities.RunStageInput) (activities.RunStageOutput, error) {
		out := stageOutput(in.Key.Stage)
		out.Verdict.PullRequest = ""
		return out, nil
	}
	h.run()

	if h.env.GetWorkflowError() == nil {
		t.Fatal("a run that reports success with no pull request is confidently wrong, and must fail instead")
	}
}

func TestWorkTicketStopsAtABlockedStageWithoutRunningTheRest(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.stage = func(in activities.RunStageInput) (activities.RunStageOutput, error) {
		out := stageOutput(in.Key.Stage)
		if in.Key.Stage == work.StageReview {
			out.Verdict = work.StageVerdict{Blocked: true, Reason: "the ticket asks for two different things"}
		}
		return out, nil
	}
	h.run()

	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("a blocked run is a decision, not a failure: %v", err)
	}
	if len(h.ran) != 2 {
		t.Fatalf("ran %v, want to stop after review — the rest would burn tokens on a plan already abandoned", h.ran)
	}
	result := h.result(t)
	if result.Outcome != work.OutcomeBlocked || result.Detail == "" {
		t.Fatalf("result = %+v, want blocked with a reason", result)
	}
}

func TestWorkTicketDeletesTheSandboxWhenAStageFails(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.stage = failingStage
	h.run()

	if h.env.GetWorkflowError() == nil {
		t.Fatal("a failed stage fails the run")
	}
	if len(h.deleted) != 1 || h.deleted[0] != "sandbox-328" {
		t.Fatalf("deleted %v, want the sandbox — a pod outliving its run is the leak the sweep exists to catch", h.deleted)
	}
}

func TestWorkTicketDeletesTheSandboxWhenTheRunIsCancelled(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.stageDelay = time.Hour
	h.cancelAt = time.Minute
	h.run()

	if err := h.env.GetWorkflowError(); !temporal.IsCanceledError(err) {
		t.Fatalf("the run was meant to be cancelled mid-stage, got %v", err)
	}
	if len(h.deleted) != 1 {
		t.Fatalf("deleted %v — cleanup must run on a disconnected context, or cancelling a run leaks its pod", h.deleted)
	}
}

func TestWorkTicketSignalsItsDispatcherOnSuccess(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.run()

	if h.done.Ticket != 328 || h.done.Outcome != work.OutcomeProposed || h.done.Failure != work.FailureNone {
		t.Fatalf("signalled %+v, want a clean completion for ticket 328", h.done)
	}
	if h.done.RunID == "" {
		t.Fatal("the dispatcher matches the report against the run it started, so the run ID is load-bearing")
	}
}

func TestWorkTicketSignalsItsDispatcherWhenItFails(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.stage = failingStage
	h.run()

	if h.done.Outcome != work.OutcomeFailed || h.done.Failure != work.FailureOther {
		t.Fatalf("signalled %+v, want a failure report — a dispatcher that is not told holds the slot until it reconciles", h.done)
	}
}

func TestWorkTicketTellsItsDispatcherWhenTheFailureWasAuth(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	// The type is the whole of what a workflow sees: an activity failure crosses
	// a process boundary, so the client's own sentinel does not survive the trip
	// and workflow code has no business importing it.
	h.labelErr = temporal.NewNonRetryableApplicationError(
		"clearing the auto label: github refused this app's credentials", activities.ErrTypeAuth, nil)
	h.run()

	if h.done.Failure != work.FailureAuth {
		t.Fatalf("signalled %+v, want an auth failure — this is the report that pauses the dispatcher, and without it "+
			"a ticket whose label cannot be removed is re-listed every poll forever", h.done)
	}
}

func TestWorkTicketClearsTheAutoLabelOnSuccess(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.run()

	if h.cleared != 1 {
		t.Fatalf("cleared %d times, want once", h.cleared)
	}
}

func TestWorkTicketClearsTheAutoLabelAfterAFailureSoTheTicketIsNotRelistedForever(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.stage = failingStage
	h.run()

	if h.cleared != 1 {
		t.Fatalf("cleared %d times, want once — a ticket left labelled is picked up again on the next poll, forever", h.cleared)
	}
}

func TestWorkTicketLeavesTheAutoLabelWhenAHumanCancelsTheRun(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.stageDelay = time.Hour
	h.cancelAt = time.Minute
	h.run()

	if err := h.env.GetWorkflowError(); !temporal.IsCanceledError(err) {
		t.Fatalf("the run was meant to be cancelled mid-stage, got %v", err)
	}
	if h.cleared != 0 {
		t.Fatal("a cancelled run decided nothing, so the ticket still wants machine work")
	}
}

func TestWorkTicketRefusesAnIncompletePolicyWithoutTouchingTheWorld(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.policy.StageTimeout = 0
	h.run()

	err := h.env.GetWorkflowError()
	if err == nil {
		t.Fatal("an incomplete policy must fail the run rather than acquire a default")
	}
	if h.created != 0 || len(h.ran) != 0 {
		t.Fatal("and it must fail before anything is created")
	}
	var app *temporal.ApplicationError
	if !errors.As(err, &app) || !app.NonRetryable() {
		t.Fatalf("retrying a bad input changes nothing, so it must be non-retryable: %v", err)
	}
}

func TestWorkTicketRunsEachStageOnItsConfiguredModel(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.config.StageModels = work.StageModels{
		Review: &work.Model{Name: "a-different-model", Effort: "high"},
	}
	h.run()

	if h.models[work.StageReview].Name != "a-different-model" {
		t.Fatalf("review ran on %+v, want its override", h.models[work.StageReview])
	}
	if h.models[work.StagePlan] != h.config.DefaultModel {
		t.Fatalf("plan ran on %+v, want the default", h.models[work.StagePlan])
	}
}

func TestWorkTicketKeysEveryStageToThisRunSoARetryResumesRatherThanRestarts(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.run()

	for stage, key := range h.keys {
		if key.Ticket != 328 || key.RunID == "" || key.Stage != stage {
			t.Fatalf("%s keyed as %+v — the key is the whole of a stage's identity", stage, key)
		}
	}
}

func TestWorkTicketPostsOneStatusCommentAndEditsThatOne(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.run()

	if len(h.reports) < 2 {
		t.Fatalf("reported %d times, want a first post and at least one edit", len(h.reports))
	}
	if h.reports[0].Comment != 0 {
		t.Fatal("the first report has no comment to edit")
	}
	for _, report := range h.reports[1:] {
		if report.Comment != 77 {
			t.Fatalf("report %+v does not carry the comment the run already posted, so it would post a second", report)
		}
	}
	if last := h.reports[len(h.reports)-1]; last.Outcome == "" {
		t.Fatal("the last report must state the outcome")
	}
}

func TestWorkTicketReportsEveryStageItStarts(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.run()

	reported := map[work.Stage]bool{}
	for _, report := range h.reports {
		if report.Stage != "" {
			reported[report.Stage] = true
		}
	}
	for _, stage := range work.Pipeline() {
		if !reported[stage] {
			t.Fatalf("no status report names %s — at 3am you must be able to see which stage a ticket is on", stage)
		}
	}
}
