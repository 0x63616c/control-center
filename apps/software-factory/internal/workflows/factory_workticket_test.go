package workflows_test

import (
	"context"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store/storefake"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
	"github.com/stretchr/testify/mock"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

// factoryDispatcherID is the id FactoryWorkTicketInput.DispatcherID carries in
// every test here — not work.FactoryDispatcherWorkflowID itself, only because
// a test's dispatcher never actually runs; any distinct string proves the
// same thing.
const factoryDispatcherID = "software-factory-ticket-dispatcher"

const (
	testFactoryPushRepoChangeID = "factory-push-repo-v1"
	testFactoryPushRepoVersion  = workflow.Version(1)
)

func cancelableAgentWorkflow(ctx workflow.Context, _ workflows.AgentWorkflowInput) (workflows.AgentWorkflowResult, error) {
	return workflows.AgentWorkflowResult{}, workflow.Await(ctx, func() bool { return false })
}

// factoryTicketHarness runs one FactoryWorkTicket workflow against a real
// storefake.Store behind the ticket/recording/transcript activities — so the
// state machine that moves a Ticket through Working/Review/Failed is
// exercised for real rather than re-implemented as a mock's side effect — and
// mocked GitHub/sandbox/codex activities, the same shape ticketHarness
// (workticket_test.go) already mocks for WorkTicket.
type factoryTicketHarness struct {
	env   *testsuite.TestWorkflowEnvironment
	store *storefake.Store

	policy work.RunPolicy
	config work.Config
	ticket store.TicketID

	cloneErr     error
	sandboxErr   error
	draftErr     error
	readyErr     error
	autoMergeErr error

	// pullRequestDraft is what OpenOrUpdatePullRequest reports the pull
	// request's own Draft bit as.
	pullRequestDraft bool

	// implement, keyed by turn (1-indexed). A turn not present runs the
	// default: not blocked, pushed, with a title and body worth noting.
	implement map[int]*activities.RunImplementOutput
	// ci, keyed by implement turn (1-indexed, counted across the whole run).
	// A turn not present observes green.
	ci map[int]activities.ObserveCIOutput
	// review, keyed by review turn (1-indexed). A turn not present raises no
	// findings.
	review map[int][]work.Finding
	// reviewFailures makes the review activity fail retryably this many times
	// before returning its configured findings.
	reviewFailures int

	// what it did.
	implementTurns   []work.StageKey
	reviewTurns      []work.StageKey
	reviewAttempts   []time.Time
	created          int
	sandboxInputs    []activities.CreateSandboxInput
	cloned           []work.SandboxID
	deleted          []work.SandboxID
	drafted          []string
	markedReady      []string
	autoMerged       []string
	openOrUpdate     int
	pullRequestInput []activities.OpenOrUpdatePullRequestInput
	done             workflows.FactoryTicketDone
	sawDone          bool

	// callOrder records, in the order they actually ran, every "CreateSandbox"
	// and "OpenOrUpdatePullRequest" call — what #603's acceptance test reads to
	// prove the push happens before the pull request is requested, not merely
	// that both happened at some point.
	callOrder []string

	agentChildren  []workflows.AgentWorkflowInput
	agentChildIDs  []string
	activityStarts []string
	lifecycle      []string

	cancelDuringAgent bool
}

func newFactoryTicketHarness(t *testing.T) *factoryTicketHarness {
	t.Helper()
	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestWorkflowEnvironment()

	// The stage loop runs under a Session (#434 step 3, D2), identical to
	// WorkTicket's own requirement — see newTicketHarness's doc comment.
	env.SetWorkerOptions(worker.Options{
		EnableSessionWorker:               true,
		MaxConcurrentSessionExecutionSize: 1,
	})

	fake := storefake.New()
	ticket, err := fake.CreateTicket(context.Background(), "a factory ticket", "do the thing", nil)
	if err != nil {
		t.Fatalf("seeding a ticket: %v", err)
	}

	ticketActivities, err := activities.NewTicketActivities(fake)
	if err != nil {
		t.Fatalf("building ticket activities: %v", err)
	}
	recordingActivities, err := activities.NewRecordingActivities(fake)
	if err != nil {
		t.Fatalf("building recording activities: %v", err)
	}
	transcriptActivities, err := activities.NewTranscriptRecordingActivities(fake)
	if err != nil {
		t.Fatalf("building transcript activities: %v", err)
	}
	env.RegisterActivity(ticketActivities)
	env.RegisterActivity(recordingActivities)
	env.RegisterActivity(transcriptActivities)

	return &factoryTicketHarness{
		env:              env,
		store:            fake,
		policy:           work.DefaultRunPolicy(),
		config:           work.DefaultFactoryConfig(),
		ticket:           ticket.ID,
		implement:        map[int]*activities.RunImplementOutput{},
		ci:               map[int]activities.ObserveCIOutput{},
		review:           map[int][]work.Finding{},
		pullRequestDraft: true,
	}
}

func (h *factoryTicketHarness) run() {
	h.runVersion(workflow.DefaultVersion)
}

func (h *factoryTicketHarness) runVersion(version workflow.Version) {
	env := h.env
	if h.cancelDuringAgent {
		env.RegisterWorkflowWithOptions(cancelableAgentWorkflow, workflow.RegisterOptions{Name: agent.WorkflowName})
	}
	env.OnGetVersion("factory-agent-workflow-v1", workflow.DefaultVersion, 1).Return(version)
	env.OnGetVersion(testFactoryPushRepoChangeID, workflow.DefaultVersion, testFactoryPushRepoVersion).Return(version)
	env.SetOnChildWorkflowStartedListener(func(info *workflow.Info, _ workflow.Context, _ converter.EncodedValues) {
		h.agentChildIDs = append(h.agentChildIDs, info.WorkflowExecution.ID)
	})
	env.SetOnActivityStartedListener(func(info *activity.Info, _ context.Context, _ converter.EncodedValues) {
		h.activityStarts = append(h.activityStarts, info.ActivityType.Name)
		if info.ActivityType.Name == "DeleteSandbox" {
			h.lifecycle = append(h.lifecycle, "sandbox-deleted")
		}
	})
	env.SetOnChildWorkflowCanceledListener(func(*workflow.Info) {
		h.lifecycle = append(h.lifecycle, "child-canceled")
	})
	env.RegisterActivityWithOptions(
		func(context.Context, activities.PersistAgentTranscriptInput) error { return nil },
		activity.RegisterOptions{Name: agent.PersistTranscriptActivityName},
	)
	// Register the retired activity wire contracts so the test environment can
	// mock histories created before FactoryWorkTicket moved to AgentWorkflow.
	env.RegisterActivityWithOptions(
		func(context.Context, activities.RunPlanInput) (*activities.RunPlanOutput, error) { return nil, nil },
		activity.RegisterOptions{Name: "RunPlan"},
	)
	env.RegisterActivityWithOptions(
		func(context.Context, activities.RunImplementInput) (*activities.RunImplementOutput, error) {
			return nil, nil
		},
		activity.RegisterOptions{Name: "RunImplement"},
	)
	env.RegisterActivityWithOptions(
		func(context.Context, activities.RunReviewInput) (*activities.RunReviewOutput, error) { return nil, nil },
		activity.RegisterOptions{Name: "RunReview"},
	)
	env.RegisterActivityWithOptions(
		func(context.Context, work.SandboxID) error { return nil },
		activity.RegisterOptions{Name: "PushRepo"},
	)

	env.OnActivity(acts.CreateSandbox, mock.Anything, mock.Anything).
		Return(func(_ context.Context, in activities.CreateSandboxInput) (work.SandboxID, error) {
			h.sandboxInputs = append(h.sandboxInputs, in)
			h.callOrder = append(h.callOrder, "CreateSandbox")
			if h.sandboxErr != nil {
				return "", h.sandboxErr
			}
			h.created++
			return "sandbox-factory", nil
		})
	env.OnActivity(acts.WaitSandboxReady, mock.Anything, mock.Anything).Return(nil)
	env.OnActivity(acts.CloneRepo, mock.Anything, mock.Anything).
		Return(func(_ context.Context, sandbox work.SandboxID) error {
			h.cloned = append(h.cloned, sandbox)
			return h.cloneErr
		})
	env.OnActivity(acts.PushRepo, mock.Anything, mock.Anything).Return(nil)
	env.OnActivity(acts.DeleteSandbox, mock.Anything, mock.Anything).
		Return(func(_ context.Context, id work.SandboxID) error {
			h.deleted = append(h.deleted, id)
			return nil
		})

	env.OnActivity("RunPlan", mock.Anything, mock.Anything).Return(planOutput(), nil)

	env.OnActivity("RunImplement", mock.Anything, mock.Anything).
		Return(func(_ context.Context, in activities.RunImplementInput) (*activities.RunImplementOutput, error) {
			h.implementTurns = append(h.implementTurns, in.Key)
			if out, ok := h.implement[in.Key.Turn]; ok {
				return out, nil
			}
			return implementOutput(false, "", "the title", "the body"), nil
		})

	env.OnActivity("RunReview", mock.Anything, mock.Anything).
		Return(func(_ context.Context, in activities.RunReviewInput) (*activities.RunReviewOutput, error) {
			h.reviewTurns = append(h.reviewTurns, in.Key)
			h.reviewAttempts = append(h.reviewAttempts, env.Now())
			if len(h.reviewAttempts) <= h.reviewFailures {
				return nil, temporal.NewApplicationError("selected model is at capacity", "Transient")
			}
			return reviewOutput(nil, h.review[in.Key.Turn]...), nil
		})

	if !h.cancelDuringAgent {
		env.OnWorkflow(workflows.AgentWorkflow, mock.Anything, mock.Anything).
			Return(func(_ workflow.Context, in workflows.AgentWorkflowInput) (workflows.AgentWorkflowResult, error) {
				h.agentChildren = append(h.agentChildren, in)
				var result work.StageOutput
				switch in.Attempt.Key.Stage {
				case work.StagePlan:
					result = planOutput().Result
				case work.StageImplement:
					h.implementTurns = append(h.implementTurns, in.Attempt.Key)
					if out, ok := h.implement[in.Attempt.Key.Turn]; ok {
						result = out.Result
					} else {
						result = implementOutput(false, "", "the title", "the body").Result
					}
				case work.StageReview:
					h.reviewTurns = append(h.reviewTurns, in.Attempt.Key)
					h.reviewAttempts = append(h.reviewAttempts, env.Now())
					result = reviewOutput(nil, h.review[in.Attempt.Key.Turn]...).Result
				}
				return workflows.AgentWorkflowResult{
					Result: result, Usage: work.Usage{InputTokens: 10, OutputTokens: 1}, UsageMeasured: true,
					TranscriptRef: agent.TranscriptRef{Key: "conversations/agent/test/transcript/0/digest", Bytes: 1, Digest: "digest"},
				}, nil
			})
	}

	env.OnActivity(acts.FindPullRequest, mock.Anything, mock.Anything).
		Return(activities.FindPullRequestOutput{Found: false}, nil)

	env.OnActivity(acts.OpenOrUpdatePullRequest, mock.Anything, mock.Anything).
		Return(func(_ context.Context, in activities.OpenOrUpdatePullRequestInput) (work.PullRequest, error) {
			h.openOrUpdate++
			h.pullRequestInput = append(h.pullRequestInput, in)
			h.callOrder = append(h.callOrder, "OpenOrUpdatePullRequest")
			return work.PullRequest{
				Number: 9, URL: "https://github.com/o/r/pull/9", NodeID: "PR_node9",
				Title: in.Title, Body: in.Body, Draft: h.pullRequestDraft,
			}, nil
		})

	env.OnActivity(acts.ObserveCI, mock.Anything, mock.Anything).
		Return(func(_ context.Context, in activities.ObserveCIInput) (activities.ObserveCIOutput, error) {
			turn := len(h.implementTurns)
			if out, ok := h.ci[turn]; ok {
				return out, nil
			}
			return activities.ObserveCIOutput{Concluded: true, Green: true}, nil
		})

	env.OnActivity(acts.ConvertPullRequestToDraft, mock.Anything, mock.Anything).
		Return(func(_ context.Context, nodeID string) error {
			h.drafted = append(h.drafted, nodeID)
			return h.draftErr
		})
	env.OnActivity(acts.MarkPullRequestReadyForReview, mock.Anything, mock.Anything).
		Return(func(_ context.Context, nodeID string) error {
			h.markedReady = append(h.markedReady, nodeID)
			return h.readyErr
		})
	env.OnActivity(acts.EnablePullRequestAutoMerge, mock.Anything, mock.Anything).
		Return(func(_ context.Context, nodeID string) error {
			h.autoMerged = append(h.autoMerged, nodeID)
			return h.autoMergeErr
		})

	env.OnSignalExternalWorkflow(mock.Anything, factoryDispatcherID, mock.Anything, workflows.SignalFactoryTicketDone, mock.Anything).
		Return(func(_, _, _, _ string, arg any) error {
			h.done = arg.(workflows.FactoryTicketDone)
			h.sawDone = true
			return nil
		})

	if h.cancelDuringAgent {
		env.RegisterDelayedCallback(env.CancelWorkflow, time.Second)
	}
	env.ExecuteWorkflow(workflows.FactoryWorkTicket, workflows.FactoryWorkTicketInput{
		TicketID:     h.ticket,
		Config:       h.config,
		Policy:       h.policy,
		DispatcherID: factoryDispatcherID,
	})
}

func (h *factoryTicketHarness) result(t *testing.T) workflows.FactoryWorkTicketResult {
	t.Helper()
	var result workflows.FactoryWorkTicketResult
	if err := h.env.GetWorkflowResult(&result); err != nil {
		t.Fatalf("workflow result: %v", err)
	}
	return result
}

// ticketState reads the Ticket's current state back out of the fake store —
// what finish actually committed, not what a caller hopes it committed.
func (h *factoryTicketHarness) ticketState(t *testing.T) store.TicketState {
	t.Helper()
	ticket, err := h.store.Ticket(context.Background(), h.ticket)
	if err != nil {
		t.Fatalf("reading ticket %d back: %v", h.ticket, err)
	}
	return ticket.State
}

func TestFactoryWorkTicketClaimsTheTicketBeforeCreatingAnything(t *testing.T) {
	t.Parallel()

	h := newFactoryTicketHarness(t)
	h.run()

	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow: %v", err)
	}
	if h.created != 1 {
		t.Fatalf("created %d sandboxes, want 1", h.created)
	}
}

// TestFactoryWorkTicketPushesTheSameBranchItOpensAPullRequestAgainst is #603's
// acceptance test: the branch CreateSandbox tells the sandbox to push
// (Env[work.SandboxBranchEnv], via CreateSandboxInput.TicketBacked) must be
// the exact branch the loop later asks GitHub to open a pull request against
// — and CreateSandbox, which is what makes the push happen (the sandbox's own
// CloneRepo activity pushes SF_BRANCH before returning), must run before
// OpenOrUpdatePullRequest for that to mean anything. Before #603 was fixed,
// CreateSandboxInput carried no TicketBacked field, SF_BRANCH was always
// BranchName's legacy branch, and this run's implement turn pushed a branch
// nothing that follows ever asked GitHub about — the exact shape of "github
// rejected the request as malformed... Field:head Code:invalid" from
// production.
func TestFactoryWorkTicketPushesTheSameBranchItOpensAPullRequestAgainst(t *testing.T) {
	t.Parallel()

	h := newFactoryTicketHarness(t)
	h.run()

	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow: %v", err)
	}

	if len(h.sandboxInputs) != 1 {
		t.Fatalf("CreateSandbox called %d times, want 1", len(h.sandboxInputs))
	}
	if len(h.pullRequestInput) == 0 {
		t.Fatal("OpenOrUpdatePullRequest was never called")
	}

	// This is the branch SpecForFactoryTicket bakes into SF_BRANCH — computed
	// independently here, the same way the production bug was two independent
	// computations disagreeing.
	runID := h.done.RunID
	if !h.sawDone {
		t.Fatal("the run never reported done; cannot recover its RunID to check the branch against")
	}
	wantBranch := work.FactoryTicketBranchName(int64(h.ticket), runID)
	for i, in := range h.pullRequestInput {
		if in.Branch != wantBranch {
			t.Fatalf("OpenOrUpdatePullRequest call %d asked about branch %q, want %q (the branch this run's sandbox was told to push)",
				i, in.Branch, wantBranch)
		}
	}

	// The push itself happens inside CloneRepo, which cannot even run until
	// CreateSandbox has returned this run's sandbox — so CreateSandbox
	// ordering first in callOrder is what "the head branch is pushed before
	// the pull request is requested" actually reduces to for this workflow.
	if len(h.callOrder) < 2 || h.callOrder[0] != "CreateSandbox" {
		t.Fatalf("call order = %v, want CreateSandbox before any OpenOrUpdatePullRequest", h.callOrder)
	}
	firstPR := -1
	for i, name := range h.callOrder {
		if name == "OpenOrUpdatePullRequest" {
			firstPR = i
			break
		}
	}
	if firstPR <= 0 {
		t.Fatalf("call order = %v, want CreateSandbox to precede the first OpenOrUpdatePullRequest", h.callOrder)
	}
}

func TestFactoryWorkTicketRefusesAnAlreadyClaimedTicket(t *testing.T) {
	t.Parallel()

	h := newFactoryTicketHarness(t)
	// Move the ticket to Working before the run starts, simulating a second
	// run racing the first: TransitionTicketState only succeeds from Open, so
	// this run's claim must fail before it creates anything.
	if _, err := h.store.TransitionTicketState(context.Background(), h.ticket, store.TicketOpen, store.TicketWorking); err != nil {
		t.Fatalf("seeding a Working ticket: %v", err)
	}
	h.run()

	if h.env.GetWorkflowError() == nil {
		t.Fatal("a run whose claim failed must fail, not proceed as if it had won it")
	}
	if h.created != 0 {
		t.Fatalf("created %d sandboxes, want none — the claim never succeeded", h.created)
	}
}

func TestFactoryWorkTicketProposedMarksThePullRequestReadyAndMovesTheTicketToReview(t *testing.T) {
	t.Parallel()

	h := newFactoryTicketHarness(t)
	h.run()

	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow: %v", err)
	}
	result := h.result(t)
	if result.Outcome != work.OutcomeProposed {
		t.Fatalf("outcome = %q, want %q", result.Outcome, work.OutcomeProposed)
	}
	if len(h.markedReady) != 1 || h.markedReady[0] != "PR_node9" {
		t.Fatalf("marked ready %v, want exactly the one pull request", h.markedReady)
	}
	if len(h.autoMerged) != 1 || h.autoMerged[0] != "PR_node9" {
		t.Fatalf("auto-merge enabled on %v, want exactly the one pull request", h.autoMerged)
	}
	if got, want := h.ticketState(t), store.TicketReview; got != want {
		t.Fatalf("ticket state = %s, want %s", got, want)
	}
	if len(h.deleted) != 1 || h.deleted[0] != "sandbox-factory" {
		t.Fatalf("deleted %v, want the sandbox cleaned up", h.deleted)
	}
	if !h.sawDone {
		t.Fatal("the dispatcher was never told this ticket finished")
	}
	if h.done.TicketID != h.ticket {
		t.Fatalf("FactoryTicketDone.TicketID = %d, want %d", h.done.TicketID, h.ticket)
	}
}

func TestFactoryWorkTicketBlockedLeavesNoTerminalActionAndFailsTheTicket(t *testing.T) {
	t.Parallel()

	h := newFactoryTicketHarness(t)
	h.implement[1] = implementOutput(true, "needs a human decision", "", "")
	h.run()

	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow: %v", err)
	}
	result := h.result(t)
	if result.Outcome != work.OutcomeBlocked {
		t.Fatalf("outcome = %q, want %q", result.Outcome, work.OutcomeBlocked)
	}
	if len(h.markedReady) != 0 || len(h.autoMerged) != 0 {
		t.Fatalf("marked ready %v / auto-merged %v — a blocked run opened no pull request to act on", h.markedReady, h.autoMerged)
	}
	if got, want := h.ticketState(t), store.TicketFailed; got != want {
		t.Fatalf("ticket state = %s, want %s", got, want)
	}
}

func TestFactoryWorkTicketExhaustedConvertsThePullRequestToDraftAndFailsTheTicket(t *testing.T) {
	t.Parallel()

	h := newFactoryTicketHarness(t)
	// Every implement turn hits the same red check: no progress, so the CI
	// window's budget runs out.
	for turn := 0; turn < 10; turn++ {
		h.ci[turn] = red("lint")
	}
	h.run()

	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow: %v", err)
	}
	result := h.result(t)
	if result.Outcome != work.OutcomeExhausted {
		t.Fatalf("outcome = %q, want %q", result.Outcome, work.OutcomeExhausted)
	}
	if len(h.drafted) != 1 || h.drafted[0] != "PR_node9" {
		t.Fatalf("converted to draft %v, want exactly the one pull request", h.drafted)
	}
	if got, want := h.ticketState(t), store.TicketFailed; got != want {
		t.Fatalf("ticket state = %s, want %s", got, want)
	}
}

func TestFactoryWorkTicketReviewFindingsStayWorkingUntilTheyClear(t *testing.T) {
	t.Parallel()

	h := newFactoryTicketHarness(t)
	h.review[1] = []work.Finding{{ID: "f1", Blocking: true, Summary: "fix this"}}
	h.run()

	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow: %v", err)
	}
	result := h.result(t)
	if result.Outcome != work.OutcomeProposed {
		t.Fatalf("outcome = %q, want %q — the second review turn raised nothing blocking", result.Outcome, work.OutcomeProposed)
	}
	if len(h.reviewTurns) != 2 {
		t.Fatalf("review turns = %v, want 2 — one that found something, one that confirmed it was fixed", h.reviewTurns)
	}
}

func TestFactoryWorkTicketRunsPlanImplementAndReviewAsAgentChildren(t *testing.T) {
	t.Parallel()

	h := newFactoryTicketHarness(t)
	h.runVersion(1)
	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow: %v", err)
	}
	result := h.result(t)
	if result.Outcome != work.OutcomeProposed || result.Usage != (work.Usage{InputTokens: 30, OutputTokens: 3}) {
		t.Fatalf("result = %#v", result)
	}
	wantStages := []work.Stage{work.StagePlan, work.StageImplement, work.StageReview}
	wantToolsets := []agent.ToolsetID{agent.ToolsetCodingReadV1, agent.ToolsetCodingWriteV1, agent.ToolsetCodingReadV1}
	if len(h.agentChildren) != len(wantStages) {
		t.Fatalf("agent children=%d", len(h.agentChildren))
	}
	for index, stage := range wantStages {
		input := h.agentChildren[index]
		wantID := agent.WorkflowID(h.done.RunID, string(stage), 1)
		if input.Attempt.Key.Stage != stage || input.ToolsetID != wantToolsets[index] || input.Limits != agent.DefaultLimits() {
			t.Fatalf("child %d input = %#v", index, input)
		}
		if h.agentChildIDs[index] != wantID {
			t.Fatalf("child %d id=%q want=%q", index, h.agentChildIDs[index], wantID)
		}
	}
	for _, activityName := range h.activityStarts {
		if activityName == "RunPlan" || activityName == "RunImplement" || activityName == "RunReview" {
			t.Fatalf("new history invoked legacy stage activity %q", activityName)
		}
	}
}

func TestFactoryWorkTicketPushesCommittedImplementBeforePullRequestAndCI(t *testing.T) {
	t.Parallel()

	h := newFactoryTicketHarness(t)
	h.runVersion(testFactoryPushRepoVersion)
	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow: %v", err)
	}

	positions := map[string]int{}
	for index, name := range h.activityStarts {
		if _, recorded := positions[name]; !recorded {
			positions[name] = index
		}
	}
	push, pushed := positions["PushRepo"]
	pullRequest, opened := positions["OpenOrUpdatePullRequest"]
	ci, observed := positions["ObserveCI"]
	if !pushed || !opened || !observed {
		t.Fatalf("activity order = %v, want PushRepo, OpenOrUpdatePullRequest, and ObserveCI", h.activityStarts)
	}
	if push >= pullRequest || pullRequest >= ci {
		t.Fatalf("activity order = %v, want PushRepo before pull request publication before CI", h.activityStarts)
	}
}

func TestFactoryWorkTicketDoesNotPushABlockedImplement(t *testing.T) {
	t.Parallel()

	h := newFactoryTicketHarness(t)
	h.implement[1] = implementOutput(true, "cannot safely finish", "", "")
	h.runVersion(testFactoryPushRepoVersion)
	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow: %v", err)
	}
	for _, name := range h.activityStarts {
		if name == "PushRepo" {
			t.Fatalf("blocked implement invoked PushRepo: %v", h.activityStarts)
		}
	}
}

func TestAgentTranscriptPersistsAfterAttemptRecording(t *testing.T) {
	t.Parallel()

	h := newFactoryTicketHarness(t)
	h.runVersion(1)
	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow: %v", err)
	}
	lastAttemptEnd := -1
	persisted := 0
	for index, activityName := range h.activityStarts {
		switch activityName {
		case "RecordAttemptEnd":
			lastAttemptEnd = index
		case agent.PersistTranscriptActivityName:
			if lastAttemptEnd < 0 || lastAttemptEnd >= index {
				t.Fatalf("activity order = %v", h.activityStarts)
			}
			persisted++
			lastAttemptEnd = -1
		}
	}
	if persisted != 3 {
		t.Fatalf("persisted transcripts = %d, want 3; activity order = %v", persisted, h.activityStarts)
	}
}

func TestFactoryWorkTicketCancellationWaitsForTheAgentChildBeforeSandboxCleanup(t *testing.T) {
	t.Parallel()

	h := newFactoryTicketHarness(t)
	h.cancelDuringAgent = true
	h.runVersion(1)
	if !temporal.IsCanceledError(h.env.GetWorkflowError()) {
		t.Fatalf("workflow error = %v, want cancellation", h.env.GetWorkflowError())
	}
	if len(h.lifecycle) != 2 || h.lifecycle[0] != "child-canceled" || h.lifecycle[1] != "sandbox-deleted" {
		t.Fatalf("cancellation lifecycle = %v", h.lifecycle)
	}
}

func TestFactoryWorkTicketRetriesATransientStageFiveTimesWithExponentialBackoff(t *testing.T) {
	t.Parallel()

	h := newFactoryTicketHarness(t)
	h.reviewFailures = 5
	h.run()

	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow: %v", err)
	}
	if got, want := len(h.reviewAttempts), 6; got != want {
		t.Fatalf("review attempts = %d, want %d", got, want)
	}
	for i, want := range []time.Duration{time.Second, 5 * time.Second, 25 * time.Second, 125 * time.Second, 5 * time.Minute} {
		got := h.reviewAttempts[i+1].Sub(h.reviewAttempts[i])
		if got != want {
			t.Fatalf("review retry %d delay = %s, want %s", i+1, got, want)
		}
	}
}

func TestFactoryWorkTicketAnInfraFailureStillCleansUpAndFailsTheTicket(t *testing.T) {
	t.Parallel()

	h := newFactoryTicketHarness(t)
	h.cloneErr = temporal.NewNonRetryableApplicationError(
		"SF_BRANCH is not set in the sandbox's own environment", activities.ErrTypePermanent, nil)
	h.run()

	if h.env.GetWorkflowError() == nil {
		t.Fatal("a run whose sandbox could not be cloned into must fail")
	}
	if len(h.implementTurns) != 0 {
		t.Fatalf("implement ran %v — no stage may run against a sandbox with no repository in it", h.implementTurns)
	}
	if len(h.deleted) != 1 || h.deleted[0] != "sandbox-factory" {
		t.Fatalf("deleted %v, want the sandbox cleaned up despite the clone failing", h.deleted)
	}
	if got, want := h.ticketState(t), store.TicketFailed; got != want {
		t.Fatalf("ticket state = %s, want %s", got, want)
	}
}
