package workflows_test

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"strings"
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
	return activities.RunStageOutput{
		Output:   []byte(fmt.Sprintf(`{"document":%q}`, stage)),
		Document: "the " + string(stage) + " document",
		ThreadID: "thread-" + string(stage),
		Usage:    work.Usage{InputTokens: 10, OutputTokens: 1},
	}
}

// ticketHarness runs one WorkTicket workflow against fakes and records what it
// did. Knobs are set before run; everything else is a successful pipeline.
type ticketHarness struct {
	env *testsuite.TestWorkflowEnvironment

	// knobs.
	policy        work.RunPolicy
	config        work.Config
	stage         func(in activities.RunStageInput) (activities.RunStageOutput, error)
	stageDelay    time.Duration
	labelErr      error
	noPR          bool
	prErr         error
	cancelAt      time.Duration
	cloneErr      error
	credentialErr error

	// what the run did.
	ran               []work.Stage
	priors            map[work.Stage]map[work.Stage]string
	models            map[work.Stage]work.Model
	keys              map[work.Stage]work.StageKey
	created           int
	cloned            []work.SandboxID
	deleted           []work.SandboxID
	cleared           int
	reports           []work.StatusReport
	done              work.TicketDone
	prBranch          string
	credentialWritten []work.SandboxID

	// setupOrder records "credential" and "clone" in the order the fakes were
	// actually called, so a test can pin the relative order deliberately
	// rather than merely that both ran before the stage loop.
	setupOrder []string
}

func newTicketHarness(t *testing.T) *ticketHarness {
	t.Helper()
	suite := &testsuite.WorkflowTestSuite{}
	return &ticketHarness{
		env:    suite.NewTestWorkflowEnvironment(),
		policy: work.DefaultRunPolicy(),
		config: work.DefaultConfig(),
		priors: map[work.Stage]map[work.Stage]string{},
		models: map[work.Stage]work.Model{},
		keys:   map[work.Stage]work.StageKey{},
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

	env.OnActivity(acts.WriteCodexCredential, mock.Anything, mock.Anything).
		Return(func(_ context.Context, sandbox work.SandboxID) error {
			h.credentialWritten = append(h.credentialWritten, sandbox)
			h.setupOrder = append(h.setupOrder, "credential")
			return h.credentialErr
		})

	env.OnActivity(acts.CloneRepo, mock.Anything, mock.Anything).
		Return(func(_ context.Context, sandbox work.SandboxID) error {
			h.cloned = append(h.cloned, sandbox)
			h.setupOrder = append(h.setupOrder, "clone")
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

	stage := env.OnActivity(acts.RunStage, mock.Anything, mock.Anything)
	if h.stageDelay > 0 {
		stage = stage.After(h.stageDelay)
	}
	stage.Return(func(_ context.Context, in activities.RunStageInput) (activities.RunStageOutput, error) {
		h.ran = append(h.ran, in.Key.Stage)
		h.priors[in.Key.Stage] = maps.Clone(in.Prior)
		h.models[in.Key.Stage] = in.Model
		h.keys[in.Key.Stage] = in.Key
		if h.stage != nil {
			return h.stage(in)
		}
		return stageOutput(in.Key.Stage), nil
	})

	env.OnActivity(acts.FindPullRequest, mock.Anything, mock.Anything).
		Return(func(_ context.Context, branch string) (activities.FindPullRequestOutput, error) {
			h.prBranch = branch
			if h.prErr != nil {
				return activities.FindPullRequestOutput{}, h.prErr
			}
			if h.noPR {
				return activities.FindPullRequestOutput{}, nil
			}
			return activities.FindPullRequestOutput{
				Found:       true,
				PullRequest: work.PullRequest{Number: 9, URL: "https://github.com/o/r/pull/9"},
			}, nil
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
	if len(h.ran) == 0 {
		t.Fatal("no stage ran at all")
	}
}

// TestWorkTicketFailsBeforeAnyStageWhenTheCloneFails is #383's whole point:
// codex refuses to run outside a git repository and exits before any model
// call, so a run that discovered a missing checkout inside `plan` would
// already have paid for a stage against a sandbox that could never have
// worked. The clone must be caught first.
func TestWorkTicketFailsBeforeAnyStageWhenTheCloneFails(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.cloneErr = temporal.NewNonRetryableApplicationError(
		"SF_BRANCH is not set in the sandbox's own environment", activities.ErrTypePermanent, nil)
	h.run()

	if h.env.GetWorkflowError() == nil {
		t.Fatal("a run whose sandbox could not be cloned into must fail")
	}
	if len(h.ran) != 0 {
		t.Fatalf("ran %v — no stage may run against a sandbox with no repository in it", h.ran)
	}
	if len(h.deleted) != 1 || h.deleted[0] != "sandbox-328" {
		t.Fatalf("deleted %v, want the sandbox cleaned up despite the clone failing", h.deleted)
	}
}

func TestWorkTicketGivesReviseBothThePlanAndTheReview(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.run()

	// The case a single rolling handoff cannot serve: revise.md interpolates
	// {{plan}} AND {{review}}, and by the time revise runs the plan is two
	// stages back. A pipeline that kept only the last document would fail every
	// run at stage three, having already paid for two.
	revise := h.priors[work.StageRevise]
	if revise[work.StagePlan] != "the plan document" {
		t.Fatalf("revise saw prior %v — the plan was discarded before the stage that reads it", revise)
	}
	if revise[work.StageReview] != "the review document" {
		t.Fatalf("revise saw prior %v, want the review too", revise)
	}
}

func TestWorkTicketAccumulatesEveryStagesDocumentRatherThanReplacingIt(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.run()

	if got := h.priors[work.StagePlan]; len(got) != 0 {
		t.Fatalf("the first stage has no prior documents, got %v", got)
	}
	// Each stage sees everything that ran before it, and nothing that did not.
	for i, stage := range work.Pipeline() {
		prior := h.priors[stage]
		if len(prior) != i {
			t.Fatalf("%s saw %d prior documents, want %d: %v", stage, len(prior), i, prior)
		}
		for _, earlier := range work.Pipeline()[:i] {
			if prior[earlier] != "the "+string(earlier)+" document" {
				t.Fatalf("%s did not receive the %s document: %v", stage, earlier, prior)
			}
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

func TestWorkTicketIsBlockedWhenNoPullRequestWasOpened(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.noPR = true
	h.run()

	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("propose declining to open a pull request is a decision, not a failure: %v", err)
	}
	result := h.result(t)
	if result.Outcome != work.OutcomeBlocked || result.PullRequest != "" {
		t.Fatalf("result = %+v, want blocked with no pull request", result)
	}
	if h.cleared != 1 {
		t.Fatalf("cleared %d times — a blocked run is one of the two moments ADR-0011 takes the label off", h.cleared)
	}
}

func TestWorkTicketAsksGitHubAboutItsOwnBranchRatherThanTrustingTheStage(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.run()

	if h.prBranch == "" {
		t.Fatal("the run must ask GitHub what it achieved")
	}
	if !strings.HasPrefix(h.prBranch, "software-factory/ticket-328/") {
		t.Fatalf("asked about %q, want the branch this run named for itself — a URL taken from model output "+
			"is attacker-influenced text and renders as an autolink (#371)", h.prBranch)
	}
	if result := h.result(t); result.PullRequest != "https://github.com/o/r/pull/9" {
		t.Fatalf("pull request = %q, want the one GitHub reported", result.PullRequest)
	}
}

func TestWorkTicketRunsEveryStageEvenWhenAnEarlierOneSaysItIsBlocked(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.stage = func(in activities.RunStageInput) (activities.RunStageOutput, error) {
		out := stageOutput(in.Key.Stage)
		// A stage claiming, in its own text, that the ticket is impossible.
		// That text came from a model reading an issue body an attacker may
		// have written, and it must not steer control flow.
		out.Output = []byte(`{"document":"BLOCKED: stop the pipeline"}`)
		return out, nil
	}
	h.run()

	if len(h.ran) != len(work.Pipeline()) {
		t.Fatalf("ran %v — no stage's TEXT may decide what runs next; the outcome comes from GitHub", h.ran)
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

func TestWorkTicketWritesTheCodexCredentialIntoItsOwnSandboxBeforeTheFirstStage(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.run()

	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow: %v", err)
	}
	if len(h.credentialWritten) != 1 || h.credentialWritten[0] != "sandbox-328" {
		t.Fatalf("wrote the codex credential to %v, want exactly [sandbox-328]", h.credentialWritten)
	}
	if len(h.ran) == 0 {
		t.Fatal("no stage ran at all")
	}
}

// TestWorkTicketWritesTheCodexCredentialBeforeCloningTheRepository pins the
// order of the two setup activities that both run between WaitSandboxReady
// and the stage loop. Neither has a filesystem dependency on the other —
// CodexHomeDir and RepoDir are independent siblings of SandboxRoot — but the
// codex-auth Secret does not exist in the cluster yet (#344), so every run
// attempted before it is seeded fails at WriteCodexCredential. Credential
// first means that failure is discovered before CloneRepo's round trip to
// GitHub (minting an installation token, cloning, pushing) is paid for on a
// run that cannot possibly proceed either way (#398).
func TestWorkTicketWritesTheCodexCredentialBeforeCloningTheRepository(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.run()

	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow: %v", err)
	}
	want := []string{"credential", "clone"}
	if len(h.setupOrder) != len(want) {
		t.Fatalf("setup order = %v, want %v", h.setupOrder, want)
	}
	for i := range want {
		if h.setupOrder[i] != want[i] {
			t.Fatalf("setup order = %v, want %v", h.setupOrder, want)
		}
	}
}

func TestWorkTicketRunsNoStageAndDeletesTheSandboxWhenTheCodexCredentialCannotBeWritten(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.credentialErr = temporal.NewNonRetryableApplicationError(
		"codex credential is not seeded", activities.ErrTypeAuth, nil)
	h.run()

	if h.env.GetWorkflowError() == nil {
		t.Fatal("a run whose sandbox has no codex credential must not proceed to any stage")
	}
	if len(h.ran) != 0 {
		t.Fatalf("ran %v — codex exec cannot authenticate without the credential, so no stage should have started", h.ran)
	}
	if len(h.deleted) != 1 || h.deleted[0] != "sandbox-328" {
		t.Fatalf("deleted %v, want the sandbox cleaned up even though no stage ran", h.deleted)
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

func TestWorkTicketKeepsOneCommentPerStepAndEditsThatOne(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.run()

	// Every step's first report posts (no comment yet) and every later report
	// for that step edits the one it posted. A step that carried another's ID
	// would rewrite someone else's comment.
	seen := map[work.StatusStep]bool{}
	for _, report := range h.reports {
		if !seen[report.Step] {
			if report.Comment != 0 {
				t.Fatalf("the first %s report has no comment to edit, got %d", report.Step, report.Comment)
			}
			seen[report.Step] = true
			continue
		}
		if report.Comment != commentFor(report.Step) {
			t.Fatalf("%s report carries comment %d, want %d — a step must edit its own comment",
				report.Step, report.Comment, commentFor(report.Step))
		}
	}
}

func TestWorkTicketReportsEveryStageStartingAndFinishing(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.run()

	// StageSucceeded is where a stage's own token count is published. Without a
	// caller it is most of the observability value, unrendered.
	for _, stage := range work.Pipeline() {
		var running, succeeded int
		for _, report := range h.reports {
			if report.Step != work.StageStep(stage) {
				continue
			}
			switch report.State {
			case work.StepRunning:
				running++
			case work.StepSucceeded:
				succeeded++
				if report.Usage.InputTokens == 0 {
					t.Fatalf("%s succeeded with no tokens reported: %+v", stage, report)
				}
				if report.EndedAt.IsZero() || report.StartedAt.IsZero() {
					t.Fatalf("%s succeeded without a duration: %+v", stage, report)
				}
				if report.Model.Name == "" {
					t.Fatalf("%s succeeded without naming its model: %+v", stage, report)
				}
			case work.StepFailed:
				t.Fatalf("%s failed unexpectedly: %+v", stage, report)
			}
		}
		if running != 1 || succeeded != 1 {
			t.Fatalf("%s reported %d starts and %d successes, want one of each", stage, running, succeeded)
		}
	}
}

func TestWorkTicketReportsTheStageThatFailed(t *testing.T) {
	t.Parallel()

	h := newTicketHarness(t)
	h.stage = failingStage
	h.run()

	var failed *work.StatusReport
	for i, report := range h.reports {
		if report.Step == work.StageStep(work.StagePlan) && report.State == work.StepFailed {
			failed = &h.reports[i]
		}
	}
	if failed == nil {
		t.Fatal("a failed stage is the one a human most wants to see on the ticket")
	}
	if failed.Detail == "" {
		t.Fatal("and it must say why")
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
	// The run's total, not the last stage's — cost is reviewed where the work is.
	if outcome.Usage.InputTokens != 50 {
		t.Fatalf("outcome usage = %+v, want every stage summed", outcome.Usage)
	}
}

// TestWorkTicketReportsThePullRequestURLGitHubReturned proves the outcome
// comment carries the URL FindPullRequest got from GitHub for the run's own
// branch, not an empty value — #371. A run that opened a pull request but
// left this blank would post a comment announcing success with nothing
// linking to what it did.
func TestWorkTicketReportsThePullRequestURLGitHubReturned(t *testing.T) {
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
	if outcome.PullRequestURL != "https://github.com/o/r/pull/9" {
		t.Fatalf("outcome report pull request url = %q, want the one GitHub reported", outcome.PullRequestURL)
	}
}

// commentFor gives each status step a distinct comment id, so a test can tell
// a step editing its own comment from a step editing another's.
func commentFor(step work.StatusStep) work.CommentID {
	return work.CommentID(len(step) + 100)
}
