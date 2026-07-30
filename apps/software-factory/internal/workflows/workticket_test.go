package workflows_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
	"github.com/stretchr/testify/mock"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/worker"
)

// acts is a nil handle used only to name activity methods for the test
// environment's mocks. Nothing is ever called on it.
var acts *activities.Activities

const dispatcherID = "software-factory-dispatcher"

// planOutput, implementOutput and reviewOutput build one turn's activity
// result, one per stage, since each answers in its own work.StageOutput
// shape. RunPlanOutput/RunImplementOutput/RunReviewOutput each embed an
// unexported stageOutput, so a value cannot be built with a struct literal
// from outside internal/activities — only its promoted exported fields
// (Output, Result, ThreadID, Usage) are reachable from here, which is enough
// to build one field by field.

func planOutput() activities.RunPlanOutput {
	var out activities.RunPlanOutput
	fillStageOutput(&out.Output, &out.Result, &out.ThreadID, &out.Usage,
		work.NewStageOutput(work.StagePlan, work.DocumentOutput{Document: "the plan"}))
	return out
}

func implementOutput(blocked bool, blockedReason, title, body string) activities.RunImplementOutput {
	var out activities.RunImplementOutput
	fillStageOutput(&out.Output, &out.Result, &out.ThreadID, &out.Usage,
		work.NewStageOutput(work.StageImplement, work.ImplementOutput{
			Report: "implemented it", Blocked: blocked, BlockedReason: blockedReason, Title: title, Body: body,
		}))
	return out
}

func reviewOutput(findings ...work.Finding) activities.RunReviewOutput {
	var out activities.RunReviewOutput
	fillStageOutput(&out.Output, &out.Result, &out.ThreadID, &out.Usage,
		work.NewStageOutput(work.StageReview, work.ReviewOutput{Document: "the review", Findings: findings}))
	return out
}

// fillStageOutput fills in the fields every *Output type promotes from its
// embedded stageOutput, so the three constructors above share one body
// rather than repeating it.
func fillStageOutput(output *[]byte, result *work.StageOutput, threadID *string, usage *work.Usage, value work.StageOutput) {
	*output = []byte(fmt.Sprintf(`{"result":%q}`, value.Stage()))
	*result = value
	*threadID = "thread-" + string(value.Stage())
	*usage = work.Usage{InputTokens: 10, OutputTokens: 1}
}

// ticketHarness runs one WorkTicket workflow against fakes and records what
// it did. Knobs are set before run; the zero-knob default is a run that
// plans once, implements once, observes CI green immediately, reviews once
// with no blocking findings, and proposes.
type ticketHarness struct {
	env *testsuite.TestWorkflowEnvironment

	// knobs.
	policy     work.RunPolicy
	config     work.Config
	labelErr   error
	cancelAt   time.Duration
	stageDelay time.Duration

	cloneErr error
	draftErr error

	// implement, keyed by turn (1-indexed). A turn not present in the map
	// runs the default: not blocked, pushed, no title/body worth noting.
	implement map[int]activities.RunImplementOutput
	// ci, keyed by implement turn. A turn not present observes green.
	ci map[int]activities.ObserveCIOutput
	// review, keyed by review turn (1-indexed, its own counter). A turn not
	// present raises no findings.
	review map[int][]work.Finding

	implementErr error
	reviewErr    error

	// what the run did.
	implementTurns   []work.StageKey
	reviewTurns      []work.StageKey
	created          int
	cloned           []work.SandboxID
	deleted          []work.SandboxID
	cleared          int
	reports          []work.StatusReport
	done             work.TicketDone
	openOrUpdate     int
	observedCI       int
	drafted          []string
	postedPRComments []prComment
}

// prComment is one comment postPullRequestComment posted, recorded so a test
// can assert on the pull request number and body without depending on
// PostStatus's own wording.
type prComment struct {
	Number int
	Body   string
}

func newTicketHarness(t *testing.T) *ticketHarness {
	t.Helper()
	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestWorkflowEnvironment()

	// The stage loop runs under a Session (#434 step 3, D2): without this,
	// CreateSession has no session worker to claim it and every run fails
	// before its first stage, in a test environment that would otherwise
	// have no opinion on Sessions at all.
	env.SetWorkerOptions(worker.Options{
		EnableSessionWorker:               true,
		MaxConcurrentSessionExecutionSize: 1,
	})

	return &ticketHarness{
		env:       env,
		policy:    work.DefaultRunPolicy(),
		config:    work.DefaultConfig(),
		implement: map[int]activities.RunImplementOutput{},
		ci:        map[int]activities.ObserveCIOutput{},
		review:    map[int][]work.Finding{},
	}
}

func (h *ticketHarness) run() {
	env := h.env

	env.OnActivity(acts.FetchTicketDetail, mock.Anything, 328).
		Return(work.TicketDetail{Ticket: work.Ticket{Number: 328, Title: "a ticket", Body: "do the thing"}}, nil)

	env.OnActivity(acts.ReportStatus, mock.Anything, mock.Anything).
		Return(func(_ context.Context, report work.StatusReport) (work.CommentID, error) {
			h.reports = append(h.reports, report)
			return commentFor(report.Step), nil
		})

	env.OnActivity(acts.CreateSandbox, mock.Anything, mock.Anything).
		Return(func(_ context.Context, _ activities.CreateSandboxInput) (work.SandboxID, error) {
			h.created++
			return "sandbox-328", nil
		})

	env.OnActivity(acts.WaitSandboxReady, mock.Anything, mock.Anything).Return(nil)

	env.OnActivity(acts.CloneRepo, mock.Anything, mock.Anything).
		Return(func(_ context.Context, sandbox work.SandboxID) error {
			h.cloned = append(h.cloned, sandbox)
			return h.cloneErr
		})

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

	env.OnActivity(acts.ConvertPullRequestToDraft, mock.Anything, mock.Anything).
		Return(func(_ context.Context, nodeID string) error {
			h.drafted = append(h.drafted, nodeID)
			return h.draftErr
		})

	env.OnActivity(acts.PostPullRequestComment, mock.Anything, mock.Anything, mock.Anything).
		Return(func(_ context.Context, pr int, body string) error {
			h.postedPRComments = append(h.postedPRComments, prComment{Number: pr, Body: body})
			return nil
		})

	plan := env.OnActivity(acts.RunPlan, mock.Anything, mock.Anything)
	if h.stageDelay > 0 {
		plan = plan.After(h.stageDelay)
	}
	plan.Return(planOutput(), nil)

	env.OnActivity(acts.RunImplement, mock.Anything, mock.Anything).
		Return(func(_ context.Context, in activities.RunImplementInput) (activities.RunImplementOutput, error) {
			h.implementTurns = append(h.implementTurns, in.Key)
			if h.implementErr != nil {
				return activities.RunImplementOutput{}, h.implementErr
			}
			if out, ok := h.implement[in.Key.Turn]; ok {
				return out, nil
			}
			return implementOutput(false, "", "the title", "the body"), nil
		})

	env.OnActivity(acts.RunReview, mock.Anything, mock.Anything).
		Return(func(_ context.Context, in activities.RunReviewInput) (activities.RunReviewOutput, error) {
			h.reviewTurns = append(h.reviewTurns, in.Key)
			if h.reviewErr != nil {
				return activities.RunReviewOutput{}, h.reviewErr
			}
			return reviewOutput(h.review[in.Key.Turn]...), nil
		})

	env.OnActivity(acts.FindPullRequest, mock.Anything, mock.Anything).
		Return(activities.FindPullRequestOutput{Found: false}, nil)

	env.OnActivity(acts.OpenOrUpdatePullRequest, mock.Anything, mock.Anything).
		Return(func(_ context.Context, in activities.OpenOrUpdatePullRequestInput) (work.PullRequest, error) {
			h.openOrUpdate++
			return work.PullRequest{
				Number: 9, URL: "https://github.com/o/r/pull/9", NodeID: "PR_node9",
				Title: in.Title, Body: in.Body,
			}, nil
		})

	env.OnActivity(acts.ObserveCI, mock.Anything, mock.Anything).
		Return(func(_ context.Context, in activities.ObserveCIInput) (activities.ObserveCIOutput, error) {
			h.observedCI++
			turn := len(h.implementTurns)
			if out, ok := h.ci[turn]; ok {
				return out, nil
			}
			return activities.ObserveCIOutput{Concluded: true, Green: true}, nil
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

// commentFor gives each status step a distinct comment id, so a test can
// tell a step editing its own comment from a step editing another's.
func commentFor(step work.StatusStep) work.CommentID {
	return work.CommentID(len(step) + 100)
}

// red returns a concluded, red ObserveCIOutput naming checks.
func red(checks ...string) activities.ObserveCIOutput {
	return activities.ObserveCIOutput{Concluded: true, Green: false, RedChecks: checks}
}

// green is a concluded, passing ObserveCIOutput.
func green() activities.ObserveCIOutput {
	return activities.ObserveCIOutput{Concluded: true, Green: true}
}

// unobserved is what ObserveCI reports when its own poll bound elapsed
// before CI concluded.
func unobserved() activities.ObserveCIOutput { return activities.ObserveCIOutput{Concluded: false} }

// --- setup / infra, carried over from the five-stage pipeline -------------

func TestWorkTicketClonesTheSandboxBeforeAnyStageRuns(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.run()

	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow: %v", err)
	}
	if len(h.cloned) != 1 || h.cloned[0] != "sandbox-328" {
		t.Fatalf("cloned %v, want exactly the one sandbox this run created", h.cloned)
	}
}

func TestWorkTicketFailsBeforeAnyStageWhenTheCloneFails(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.cloneErr = temporal.NewNonRetryableApplicationError(
		"SF_BRANCH is not set in the sandbox's own environment", activities.ErrTypePermanent, nil)
	h.run()

	if h.env.GetWorkflowError() == nil {
		t.Fatal("a run whose sandbox could not be cloned into must fail")
	}
	if len(h.implementTurns) != 0 {
		t.Fatalf("implement ran %v — no stage may run against a sandbox with no repository in it", h.implementTurns)
	}
	if len(h.deleted) != 1 || h.deleted[0] != "sandbox-328" {
		t.Fatalf("deleted %v, want the sandbox cleaned up despite the clone failing", h.deleted)
	}
}

func TestWorkTicketDeletesTheSandboxWhenTheRunIsCancelled(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.stageDelay = time.Hour
	h.cancelAt = time.Minute
	h.run()

	if err := h.env.GetWorkflowError(); !temporal.IsCanceledError(err) {
		t.Fatalf("the run was meant to be cancelled, got %v", err)
	}
	if len(h.deleted) != 1 {
		t.Fatalf("deleted %v — cleanup must run on a disconnected context, or cancelling a run leaks its pod", h.deleted)
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
	if h.created != 0 || len(h.implementTurns) != 0 {
		t.Fatal("and it must fail before anything is created")
	}
	var app *temporal.ApplicationError
	if !errors.As(err, &app) || !app.NonRetryable() {
		t.Fatalf("retrying a bad input changes nothing, so it must be non-retryable: %v", err)
	}
}

// --- the happy path ---------------------------------------------------------

func TestWorkTicketProposesOnAGreenFirstWindowWithNoBlockingFindings(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.run()

	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow: %v", err)
	}
	result := h.result(t)
	if result.Outcome != work.OutcomeProposed {
		t.Fatalf("outcome = %s, want proposed", result.Outcome)
	}
	if result.PullRequest.URL != "https://github.com/o/r/pull/9" || result.PullRequest.NodeID != "PR_node9" {
		t.Fatalf("pull request = %+v, want the one the loop opened", result.PullRequest)
	}
	if len(h.implementTurns) != 1 || len(h.reviewTurns) != 1 {
		t.Fatalf("implement turns = %d, review turns = %d, want exactly one each on the happy path",
			len(h.implementTurns), len(h.reviewTurns))
	}
	if h.openOrUpdate != 1 {
		t.Fatalf("opened/updated the pull request %d times, want once (after the one successful push)", h.openOrUpdate)
	}
}

func TestWorkTicketKeysEachTurnToThisRunWithAOneIndexedTurnNumber(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.ci = map[int]activities.ObserveCIOutput{1: red("build"), 2: green()}
	h.run()

	if len(h.implementTurns) != 2 {
		t.Fatalf("implement turns = %d, want 2", len(h.implementTurns))
	}
	for i, key := range h.implementTurns {
		if key.Turn != i+1 || key.Stage != work.StageImplement || key.Ticket != 328 || key.RunID == "" {
			t.Fatalf("implement turn %d keyed as %+v", i, key)
		}
	}
	if len(h.reviewTurns) != 1 || h.reviewTurns[0].Turn != 1 {
		t.Fatalf("review turns = %+v, want exactly one at turn 1", h.reviewTurns)
	}
}

// --- CI-exhaustion, window 1, never reaching review -------------------------

// TestWorkTicketTerminatesAtFiveOnAnAllRedRunNeverReachingReview is the
// acceptance test the pipeline-rewrite spec names specifically to catch the
// old, wrong "23 regardless of when CI fails" assumption: under the real
// schedule, an all-red run terminates at 5, in window 1, having never run
// review at all.
func TestWorkTicketTerminatesAtFiveOnAnAllRedRunNeverReachingReview(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	// Alternating check names: neither turn's red set is ever a subset of
	// the previous turn's, so rule 1 never fires and this isolates the
	// counter backstop alone — a repeated name here would trip rule 1 first
	// and terminate at 2, testing the wrong mechanism.
	h.ci = map[int]activities.ObserveCIOutput{
		1: red("A"), 2: red("B"), 3: red("A"), 4: red("B"), 5: red("A"),
	}
	h.run()

	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("counter exhaustion is a decision, not an error: %v", err)
	}
	result := h.result(t)
	if result.Outcome != work.OutcomeExhausted {
		t.Fatalf("outcome = %s, want exhausted", result.Outcome)
	}
	if len(h.implementTurns) != 5 {
		t.Fatalf("implement turns = %d, want exactly 5 (the ci_turns backstop), not 15 or 23", len(h.implementTurns))
	}
	if len(h.reviewTurns) != 0 {
		t.Fatalf("review turns = %d, want zero — review never runs in a window that stays red", len(h.reviewTurns))
	}
}

// --- the 15-turn worst case, review-exhaustion path -------------------------

func TestWorkTicketTerminatesAfterFifteenImplementAndThreeReviewOnRepeatedReviewExhaustion(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	// Each of 3 windows: 4 reds then a green (5 implement turns/window).
	// Alternating check names within each window so rule 1 never fires and
	// this isolates the counter backstop.
	h.ci = map[int]activities.ObserveCIOutput{
		1: red("A"), 2: red("B"), 3: red("A"), 4: red("B"), 5: green(),
		6: red("A"), 7: red("B"), 8: red("A"), 9: red("B"), 10: green(),
		11: red("A"), 12: red("B"), 13: red("A"), 14: red("B"), 15: green(),
	}
	// Each of 3 reviews raises a fresh, non-repeating blocking finding, so
	// rule 2 never fires and the run runs out on the counter alone.
	h.review = map[int][]work.Finding{
		1: {{ID: "finding-1", Blocking: true, Summary: "one"}},
		2: {{ID: "finding-2", Blocking: true, Summary: "two"}},
		3: {{ID: "finding-3", Blocking: true, Summary: "three"}},
	}
	h.run()

	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("counter exhaustion is a decision, not an error: %v", err)
	}
	result := h.result(t)
	if result.Outcome != work.OutcomeExhausted {
		t.Fatalf("outcome = %s, want exhausted", result.Outcome)
	}
	if len(h.implementTurns) != 15 {
		t.Fatalf("implement turns = %d, want exactly 15 (work.MaxStageInvocations' derivation)", len(h.implementTurns))
	}
	if len(h.reviewTurns) != 3 {
		t.Fatalf("review turns = %d, want exactly 3, no fourth window", len(h.reviewTurns))
	}
}

// --- ci_turns resets on green, mid-run --------------------------------------

func TestWorkTicketResetsCiTurnsOnGreenAndTheNextWindowStartsFromZero(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	// Window 1: red, red, green (proceeds to review before exhausting).
	// Window 2 (after a blocking finding reopens one): red, red, red, red,
	// green — if window 2's reds accumulated onto window 1's, this would
	// exhaust at turn 4 of window 2 (turn 6 overall) instead of reaching
	// green on turn 5 of window 2 (turn 8 overall). Check names alternate
	// within each window so rule 1 never fires and only the counter's own
	// reset is under test.
	h.ci = map[int]activities.ObserveCIOutput{
		1: red("A"), 2: red("B"), 3: green(),
		4: red("A"), 5: red("B"), 6: red("A"), 7: red("B"), 8: green(),
	}
	h.review = map[int][]work.Finding{
		1: {{ID: "finding-1", Blocking: true, Summary: "one"}},
		// review turn 2 raises nothing: the run proposes after window 2.
	}
	h.run()

	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow: %v", err)
	}
	result := h.result(t)
	if result.Outcome != work.OutcomeProposed {
		t.Fatalf("outcome = %s, want proposed — window 2's reds must not have inherited window 1's count", result.Outcome)
	}
	if len(h.implementTurns) != 8 {
		t.Fatalf("implement turns = %d, want 8 (3 + 5)", len(h.implementTurns))
	}
	if len(h.reviewTurns) != 2 {
		t.Fatalf("review turns = %d, want 2", len(h.reviewTurns))
	}
}

// --- rule 2: a repeated blocking finding fires before either counter -------

func TestWorkTicketTerminatesWhenTheSameBlockingFindingSurvivesAReview(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	// CI green immediately every window; review turns 1 and 2 both raise the
	// identical blocking finding id.
	h.review = map[int][]work.Finding{
		1: {{ID: "same-finding", Blocking: true, Summary: "one"}},
		2: {{ID: "same-finding", Blocking: true, Summary: "still here"}},
	}
	h.run()

	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("a stalled run is a decision, not an error: %v", err)
	}
	result := h.result(t)
	if result.Outcome != work.OutcomeExhausted {
		t.Fatalf("outcome = %s, want exhausted", result.Outcome)
	}
	if len(h.implementTurns) != 2 {
		t.Fatalf("implement turns = %d, want exactly 2 (one per CI window before each review)", len(h.implementTurns))
	}
	if len(h.reviewTurns) != 2 {
		t.Fatalf("review turns = %d, want exactly 2 — rule 2 fires on the second, not a third window", len(h.reviewTurns))
	}
}

func TestWorkTicketANewBlockingFindingIsProgressNotAStall(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.review = map[int][]work.Finding{
		1: {{ID: "finding-a", Blocking: true, Summary: "one"}},
		2: {{ID: "finding-b", Blocking: true, Summary: "different"}},
		// review turn 3 raises nothing: proposes.
	}
	h.run()

	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow: %v", err)
	}
	result := h.result(t)
	if result.Outcome != work.OutcomeProposed {
		t.Fatalf("outcome = %s, want proposed — an entirely new finding id is progress, not a stall", result.Outcome)
	}
	if len(h.reviewTurns) != 3 {
		t.Fatalf("review turns = %d, want 3", len(h.reviewTurns))
	}
}

// --- rule 3: blocked stops immediately --------------------------------------

func TestWorkTicketBlockedStopsImmediatelyRegardlessOfRemainingBudget(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.implement = map[int]activities.RunImplementOutput{
		2: implementOutput(true, "needs a human decision", "", ""),
	}
	// Turn 1 red, so the window continues to a turn 2 rather than reaching
	// review after turn 1 alone. If blocked were not checked first, turn 2
	// would also be asked about CI.
	h.ci = map[int]activities.ObserveCIOutput{1: red("build")}
	h.run()

	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("blocked is a decision, not an error: %v", err)
	}
	result := h.result(t)
	if result.Outcome != work.OutcomeBlocked || result.Detail != "needs a human decision" {
		t.Fatalf("result = %+v, want blocked with the reason implement gave", result)
	}
	if len(h.implementTurns) != 2 {
		t.Fatalf("implement turns = %d, want exactly 2 — no turn after the blocked one", len(h.implementTurns))
	}
	if h.observedCI != 1 {
		t.Fatalf("observed CI %d times, want exactly 1 (turn 1's, before the blocked turn 2) — "+
			"rule 3 is checked ahead of CI/review machinery", h.observedCI)
	}
	if len(h.reviewTurns) != 0 {
		t.Fatal("no review after a blocked implement turn")
	}
}

// --- unobserved CI carries forward the last observed red set ---------------

func TestWorkTicketUnobservedCICarriesForwardTheLastObservedRedSetRatherThanResetting(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	// Turn 1: red {A,B}. Turn 2: unobserved. Turn 3: red {A}. If the
	// unobserved turn reset the comparison to empty, turn 3's {A} would not
	// be a subset of an empty set and rule 1 would not fire; it must instead
	// compare against turn 1's {A,B} and terminate.
	h.ci = map[int]activities.ObserveCIOutput{
		1: red("A", "B"),
		2: unobserved(),
		3: red("A"),
	}
	h.run()

	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("a stalled run is a decision, not an error: %v", err)
	}
	result := h.result(t)
	if result.Outcome != work.OutcomeExhausted {
		t.Fatalf("outcome = %s, want exhausted on turn 3's rule-1 comparison against turn 1's observed set", result.Outcome)
	}
	if len(h.implementTurns) != 3 {
		t.Fatalf("implement turns = %d, want exactly 3", len(h.implementTurns))
	}
	if len(h.reviewTurns) != 0 {
		t.Fatal("review must never run in a window that never reaches green")
	}
}

func TestWorkTicketUnobservedCICountsAgainstTheCounterAsRed(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.ci = map[int]activities.ObserveCIOutput{
		1: unobserved(), 2: unobserved(), 3: unobserved(), 4: unobserved(), 5: unobserved(),
	}
	h.run()

	result := h.result(t)
	if result.Outcome != work.OutcomeExhausted {
		t.Fatalf("outcome = %s, want exhausted — an unknown CI outcome must not be free progress", result.Outcome)
	}
	if len(h.implementTurns) != 5 {
		t.Fatalf("implement turns = %d, want exactly 5", len(h.implementTurns))
	}
}

// --- dispatcher / label / usage, adapted for the loop -----------------------

func TestWorkTicketTotalsTheTokensEveryTurnSpent(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.ci = map[int]activities.ObserveCIOutput{1: red("x")}
	h.run()

	result := h.result(t)
	// plan + 2 implement turns + 1 review turn = 4 stage invocations, 10 in
	// / 1 out tokens each.
	if result.Usage.InputTokens != 40 || result.Usage.OutputTokens != 4 {
		t.Fatalf("usage = %+v, want the sum of every turn that actually ran", result.Usage)
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

func TestWorkTicketLeavesTheAutoLabelWhenAHumanCancelsTheRun(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.stageDelay = time.Hour
	h.cancelAt = time.Minute
	h.run()

	if err := h.env.GetWorkflowError(); !temporal.IsCanceledError(err) {
		t.Fatalf("the run was meant to be cancelled, got %v", err)
	}
	if h.cleared != 0 {
		t.Fatal("a cancelled run decided nothing, so the ticket still wants machine work")
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

func TestWorkTicketRunsEachTurnOnItsConfiguredModel(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.config.StageModels = work.StageModels{
		Review: &work.Model{Name: "a-different-model", Effort: "high"},
	}
	h.run()

	var sawReviewModel work.Model
	for _, report := range h.reports {
		if report.Step == work.StageStep(work.StageReview) && report.State == work.StepSucceeded {
			sawReviewModel = report.Model
		}
	}
	if sawReviewModel.Name != "a-different-model" {
		t.Fatalf("review ran on %+v, want its override", sawReviewModel)
	}
}

func TestWorkTicketReportsTheOutcomeWithTheRunsTotal(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.run()

	var outcome *work.StatusReport
	for i, report := range h.reports {
		if report.Step == work.StepOutcome {
			outcome = &h.reports[i]
		}
	}
	if outcome == nil {
		t.Fatal("a run must say how it ended")
	}
	if outcome.Outcome != work.OutcomeProposed || outcome.State != work.StepSucceeded {
		t.Fatalf("outcome report = %+v, want a proposed run", outcome)
	}
	if outcome.PullRequestURL != "https://github.com/o/r/pull/9" {
		t.Fatalf("outcome report pull request url = %q, want the one the loop opened", outcome.PullRequestURL)
	}
}

// --- terminal-cleanup ordering (slice iii's decline, wired here) -----------

func TestWorkTicketDeclinesADeclinedRunDraftFirstThenLabelThenComment(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.review = map[int][]work.Finding{
		1: {{ID: "same-finding", Blocking: true, Summary: "one"}},
		2: {{ID: "same-finding", Blocking: true, Summary: "still here"}},
	}
	h.run()

	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("a successful decline must not fail the workflow: %v", err)
	}
	result := h.result(t)
	if result.Outcome != work.OutcomeExhausted {
		t.Fatalf("outcome = %s, want exhausted", result.Outcome)
	}
	if len(h.drafted) != 1 || h.drafted[0] != "PR_node9" {
		t.Fatalf("drafted %v, want exactly the run's own pull request node id once", h.drafted)
	}
	if h.cleared != 1 {
		t.Fatalf("cleared the auto label %d times, want exactly once — decline owns it, finish must not also clear it", h.cleared)
	}
	if len(h.postedPRComments) != 1 {
		t.Fatalf("posted %d pull request comments, want exactly one — the run's own full-detail comment", len(h.postedPRComments))
	}
	comment := h.postedPRComments[0]
	if comment.Number != 9 {
		t.Fatalf("commented on pull request #%d, want #9, the run's own", comment.Number)
	}
	if !strings.Contains(comment.Body, "same-finding") {
		t.Fatalf("comment body = %q, want it to name the repeated finding that stalled the run", comment.Body)
	}
	if !strings.Contains(comment.Body, "the plan") {
		t.Fatalf("comment body = %q, want the plan the loop was working from", comment.Body)
	}
}

// TestWorkTicketFailsRatherThanCompleteWhenDraftConversionExhaustsItsRetries
// is the test that specifically guards against the looks-like-success
// failure mode the terminal-state split exists to prevent: a declined run
// whose pull request could not be converted to draft must not clear the
// label and must not report a normal Complete.
func TestWorkTicketFailsRatherThanCompleteWhenDraftConversionExhaustsItsRetries(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.review = map[int][]work.Finding{
		1: {{ID: "same-finding", Blocking: true, Summary: "one"}},
		2: {{ID: "same-finding", Blocking: true, Summary: "still here"}},
	}
	h.draftErr = temporal.NewNonRetryableApplicationError(
		"github refused this app's credentials", activities.ErrTypeAuth, nil)
	h.run()

	if err := h.env.GetWorkflowError(); err == nil {
		t.Fatal("a run whose pull request could not be converted to draft must Fail, not Complete with a declined outcome")
	}
	if h.cleared != 0 {
		t.Fatal("the auto label must stay on when draft conversion fails, or a Failed workflow's ticket looks resolved")
	}
	// The full-detail comment is best-effort and additive — it cannot itself
	// be mistaken for approval — so decline still posts it even though draft
	// conversion failed, per terminal.go's own doc comment.
	if len(h.postedPRComments) != 1 {
		t.Fatalf("posted %d pull request comments, want exactly one even though draft conversion failed", len(h.postedPRComments))
	}
}
