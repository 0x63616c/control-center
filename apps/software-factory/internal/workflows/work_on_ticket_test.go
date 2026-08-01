package workflows_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store/storefake"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/worker"
)

// TestWorkOnTicketClaimsBeforeProvisioningGenerationOneAndClonesThroughItsSession
// holds the first target-run boundary: the Store records ownership before a
// Run Worker exists, Session creation is the readiness handoff, and clone is
// the first repository-affine activity on that worker's queue.
func TestWorkOnTicketClaimsBeforeProvisioningGenerationOneAndClonesThroughItsSession(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	recorderStore := storefake.New()
	ticket, err := recorderStore.CreateTicket(ctx, "target run", "clone the repository", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	input := workflows.WorkOnTicketInput{
		TicketID: ticket.ID,
		RunID:    "0f466627-b3ae-4ba2-9c96-6ef44ec6f578",
		Policy:   work.DefaultTargetRunPolicy(),
		CloneURL: "https://github.com/example/repository.git",
		Model:    work.Model{Name: "gpt-5", Effort: "high"},
	}

	winner := newWorkOnTicketHarness(t, recorderStore)
	winner.run(input)
	if err := winner.env.GetWorkflowError(); err != nil {
		t.Fatalf("winning WorkOnTicket: %v", err)
	}
	if winner.provisioned.Identity.Generation != 1 {
		t.Fatalf("provisioned generation = %d, want 1", winner.provisioned.Identity.Generation)
	}
	claimed, err := recorderStore.Ticket(ctx, ticket.ID)
	if err != nil {
		t.Fatalf("Ticket: %v", err)
	}
	if claimed.State != store.TicketDone || claimed.ActiveRunID != "" {
		t.Fatalf("completed ticket = %+v, want done with no active owner", claimed)
	}
	if winner.clone.Step.StepOrdinal != 1 || winner.clone.Step.Branch != winner.provisioned.Branch || winner.clone.CloneURL != input.CloneURL {
		t.Fatalf("clone = %+v, provision = %+v", winner.clone, winner.provisioned)
	}
	loser := newWorkOnTicketHarness(t, recorderStore)
	loserInput := input
	loserInput.RunID = "0f466627-b3ae-4ba2-9c96-6ef44ec6f579"
	loser.run(loserInput)
	if err := loser.env.GetWorkflowError(); err == nil {
		t.Fatal("losing WorkOnTicket succeeded")
	}
	if loser.provisioned.Identity != (work.RunWorkerIdentity{}) || loser.clone.Step != (activities.RepositoryStep{}) {
		t.Fatalf("losing WorkOnTicket reached private work: provision = %+v, clone = %+v", loser.provisioned, loser.clone)
	}
}

// TestWorkOnTicketConfirmsMergeBeforeBestEffortTeardown specifies one complete
// target happy path. The Store is the public durable seam: every primary
// operation owns one ordered Step, only agent Steps own Attempts, and a
// confirmed squash merge makes the still-owned Ticket done before teardown.
func TestWorkOnTicketConfirmsMergeBeforeBestEffortTeardown(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	recorderStore := storefake.New()
	ticket, err := recorderStore.CreateTicket(ctx, "target run", "finish the ticket", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	input := workflows.WorkOnTicketInput{
		TicketID: ticket.ID,
		RunID:    "f37fcbca-b509-4823-8e7d-f7c7462b9dc8",
		Policy:   work.DefaultTargetRunPolicy(),
		CloneURL: "https://github.com/example/repository.git",
		Model:    work.Model{Name: "gpt-5", Effort: "high"},
	}

	h := newWorkOnTicketHarness(t, recorderStore)
	h.run(input)
	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("WorkOnTicket: %v", err)
	}

	detail, err := recorderStore.TargetRunDetail(ctx, input.RunID)
	if err != nil {
		t.Fatalf("TargetRunDetail: %v", err)
	}
	wantSteps := []work.StepKind{
		work.StepCloneRepository,
		work.StepPlan,
		work.StepImplement,
		work.StepSyncPullRequest,
		work.StepAwaitCI,
		work.StepReview,
		work.StepMarkPullRequestReady,
		work.StepMergePullRequest,
	}
	if len(detail.Steps) != len(wantSteps) {
		t.Fatalf("step count = %d, want %d (%v)", len(detail.Steps), len(wantSteps), detail.Steps)
	}
	for index, want := range wantSteps {
		step := detail.Steps[index]
		if step.Step.Kind != want || step.Step.Ordinal != index+1 || step.Step.State != work.StepStateCompleted {
			t.Fatalf("step %d = %+v, want completed %s", index+1, step.Step, want)
		}
		wantAttempts := 0
		if want == work.StepPlan || want == work.StepImplement || want == work.StepReview {
			wantAttempts = 1
		}
		if len(step.Attempts) != wantAttempts {
			t.Fatalf("step %s attempts = %d, want %d", want, len(step.Attempts), wantAttempts)
		}
	}

	if h.ci.Step.PushedHead != "H1" || h.ci.CI.CommitSHA != "H1" {
		t.Fatalf("CI was not bound to H1: %+v", h.ci)
	}
	if h.reviewHead != "H1" {
		t.Fatalf("review candidate head = %q, want H1", h.reviewHead)
	}
	if h.merge.ExpectedHeadSHA != "H1" || h.merge.Step.PushedHead != "H1" {
		t.Fatalf("merge was not bound to H1: %+v", h.merge)
	}
	if h.ready.Step.PullRequestNodeID != "PR_node1" {
		t.Fatalf("ready input = %+v, want authoritative PR node", h.ready)
	}
	if len(h.rotations) != 3 {
		t.Fatalf("credential rotations = %d, want one per agent attempt", len(h.rotations))
	}
	for index, agent := range h.agentInputs {
		if agent.CredentialRevision.Identity != h.provisioned.Identity || agent.CredentialRevision.Revision != string(rune('1'+index)) {
			t.Fatalf("agent %s credential expectation = %+v", agent.Stage, agent.CredentialRevision)
		}
	}

	storedTicket, err := recorderStore.Ticket(ctx, ticket.ID)
	if err != nil {
		t.Fatalf("Ticket: %v", err)
	}
	if storedTicket.State != store.TicketDone || storedTicket.ActiveRunID != "" {
		t.Fatalf("terminal ticket = %+v, want done with no owner", storedTicket)
	}
	if detail.Run.TargetOutcome != work.RunOutcomeSucceeded || detail.Run.ReviewedHead != "H1" || detail.Run.MergeSHA != "M1" {
		t.Fatalf("terminal run = %+v, want confirmed H1/M1 success", detail.Run)
	}
	if len(h.deleted) != int(input.Policy.Teardown.Retry.MaximumAttempts) || h.deleted[0].Identity != h.provisioned.Identity {
		t.Fatalf("teardown calls = %+v, want %d bounded retries for the successful worker", h.deleted, input.Policy.Teardown.Retry.MaximumAttempts)
	}
}

// A red CI result is completed feedback, not a workflow failure. The next
// implement Step must be a new durable Step but continue the surviving
// generation's implementer thread, then send the new authoritative head
// through CI and a fresh review before merge.
func TestWorkOnTicketRepairsRedCIThenReviewsTheNewHead(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	recorderStore := storefake.New()
	ticket, err := recorderStore.CreateTicket(ctx, "repair red CI", "make CI green", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	input := workflows.WorkOnTicketInput{
		TicketID: ticket.ID,
		RunID:    "019fb901-0000-7000-8000-000000000001",
		Policy:   work.DefaultTargetRunPolicy(),
		CloneURL: "https://github.com/example/repository.git",
		Model:    work.Model{Name: "gpt-5", Effort: "high"},
	}

	h := newWorkOnTicketHarness(t, recorderStore)
	h.sync = func(in activities.TargetSyncPullRequestInput) (work.PullRequest, error) {
		head := "H1"
		if len(h.syncInputs) == 2 {
			head = "H2"
		}
		position := in.Step
		position.PushedHead = head
		position.PullRequestNumber, position.PullRequestNodeID = 1, "PR_node1"
		if err := h.checkpointRepositoryStep(position); err != nil {
			return work.PullRequest{}, err
		}
		return work.PullRequest{Number: 1, NodeID: "PR_node1", HeadSHA: head, Draft: true}, nil
	}
	h.awaitCI = func(in activities.TargetAwaitCIInput) (activities.AwaitCIOutput, error) {
		if err := h.checkpointRepositoryStep(in.Step); err != nil {
			return activities.AwaitCIOutput{}, err
		}
		if in.CI.CommitSHA == "H1" {
			return activities.AwaitCIOutput{CommitSHA: "H1", Green: false, RedFailures: []work.CheckFailure{{Name: "test-software-factory", Fingerprint: "ci-red", Evidence: "expected true to be false"}}}, nil
		}
		return activities.AwaitCIOutput{CommitSHA: "H2", Green: true}, nil
	}
	h.run(input)
	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("WorkOnTicket: %v", err)
	}

	detail, err := recorderStore.TargetRunDetail(ctx, input.RunID)
	if err != nil {
		t.Fatalf("TargetRunDetail: %v", err)
	}
	wantSteps := []work.StepKind{
		work.StepCloneRepository, work.StepPlan, work.StepImplement,
		work.StepSyncPullRequest, work.StepAwaitCI, work.StepImplement,
		work.StepSyncPullRequest, work.StepAwaitCI, work.StepReview,
		work.StepMarkPullRequestReady, work.StepMergePullRequest,
	}
	if len(detail.Steps) != len(wantSteps) {
		t.Fatalf("steps = %d, want %d: %+v", len(detail.Steps), len(wantSteps), detail.Steps)
	}
	for index, want := range wantSteps {
		if got := detail.Steps[index].Step.Kind; got != want {
			t.Fatalf("step %d kind = %q, want %q", index+1, got, want)
		}
	}
	var implements []activities.TargetAgentInput
	var reviews []activities.TargetAgentInput
	for _, agent := range h.agentInputs {
		switch agent.Stage {
		case work.AgentStagePlan:
		case work.AgentStageImplement:
			implements = append(implements, agent)
		case work.AgentStageReview:
			reviews = append(reviews, agent)
		}
	}
	if len(implements) != 2 || implements[1].PriorProviderThread == nil || implements[1].PriorProviderThread.Identity != h.provisioned.Identity || implements[1].PriorProviderThread.ThreadID != "implement-thread" {
		t.Fatalf("implement feedback continuation = %+v, want the original implementer thread on generation one", implements)
	}
	if len(reviews) != 1 || reviews[0].PromptContext.CandidateHeadSHA != "H2" {
		t.Fatalf("reviews = %+v, want one fresh H2 review", reviews)
	}
	if h.merge.ExpectedHeadSHA != "H2" {
		t.Fatalf("merge = %+v, want only reviewed H2", h.merge)
	}
}

// A blocking review is completed, authoritative feedback. It must reopen the
// surviving implementer with both the reviewed head and structured findings,
// then bind CI and an independent reviewer to the new head before merge.
func TestWorkOnTicketRepairsBlockingReviewWithFreshCandidateAuthorization(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	s := storefake.New()
	ticket, err := s.CreateTicket(ctx, "review feedback", "repair the finding", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	in := workflows.WorkOnTicketInput{TicketID: ticket.ID, RunID: "019fb901-0000-7000-8000-000000000007", Policy: work.DefaultTargetRunPolicy(), CloneURL: "https://github.com/example/repository.git", Model: work.Model{Name: "gpt-5", Effort: "high"}}
	h := newWorkOnTicketHarness(t, s)
	h.sync = func(input activities.TargetSyncPullRequestInput) (work.PullRequest, error) {
		head := "H1"
		if len(h.syncInputs) == 2 {
			head = "H2"
		}
		position := input.Step
		position.PushedHead, position.PullRequestNumber, position.PullRequestNodeID = head, 1, "PR_node1"
		if err := h.checkpointRepositoryStep(position); err != nil {
			return work.PullRequest{}, err
		}
		return work.PullRequest{Number: 1, NodeID: "PR_node1", HeadSHA: head, Draft: true}, nil
	}
	h.awaitCI = func(input activities.TargetAwaitCIInput) (activities.AwaitCIOutput, error) {
		if err := h.checkpointRepositoryStep(input.Step); err != nil {
			return activities.AwaitCIOutput{}, err
		}
		return activities.AwaitCIOutput{CommitSHA: input.CI.CommitSHA, Green: true}, nil
	}
	reviews := 0
	h.agentResult = func(input activities.TargetAgentInput) (activities.TargetAgentOutput, error) {
		if input.Stage != work.AgentStageReview {
			return targetAgentOutput(t, input.Stage), nil
		}
		reviews++
		if reviews != 1 {
			return targetAgentOutput(t, input.Stage), nil
		}
		var result work.StageOutput
		raw := `{"stage":"review","value":{"document":"blocked","findings":[{"id":"finding_1","blocking":true,"summary":"repair the boundary"}]}}`
		if err := json.Unmarshal([]byte(raw), &result); err != nil {
			return activities.TargetAgentOutput{}, err
		}
		return activities.TargetAgentOutput{Output: json.RawMessage(raw), Result: result, ThreadID: "review-thread-1", UsageState: work.UsageMeasured}, nil
	}
	h.run(in)
	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("WorkOnTicket: %v", err)
	}

	var implements, reviewInputs []activities.TargetAgentInput
	for _, agent := range h.agentInputs {
		switch agent.Stage {
		case work.AgentStagePlan:
		case work.AgentStageImplement:
			implements = append(implements, agent)
		case work.AgentStageReview:
			reviewInputs = append(reviewInputs, agent)
		}
	}
	if len(implements) != 2 || implements[1].PriorProviderThread == nil || implements[1].PriorProviderThread.Identity != h.provisioned.Identity || implements[1].PriorProviderThread.ThreadID != "implement-thread" || implements[1].PromptContext.CandidateHeadSHA != "H1" || len(implements[1].PromptContext.ReviewFindings) != 1 || implements[1].PromptContext.ReviewFindings[0].ID != "finding_1" {
		t.Fatalf("review-feedback implementation = %+v, want same-generation H1 implementer handoff with typed finding", implements)
	}
	if len(h.ciInputs) != 2 || h.ciInputs[0].CI.CommitSHA != "H1" || h.ciInputs[1].CI.CommitSHA != "H2" || len(reviewInputs) != 2 || reviewInputs[0].PromptContext.CandidateHeadSHA != "H1" || reviewInputs[1].PromptContext.CandidateHeadSHA != "H2" || reviewInputs[0].PriorProviderThread != nil || reviewInputs[1].PriorProviderThread != nil {
		t.Fatalf("fresh candidate authorization = CI %+v, reviews %+v", h.ciInputs, reviewInputs)
	}
	if h.merge.ExpectedHeadSHA != "H2" {
		t.Fatalf("merge = %+v, want only reviewed H2", h.merge)
	}
	detail, err := s.TargetRunDetail(ctx, in.RunID)
	if err != nil {
		t.Fatalf("TargetRunDetail: %v", err)
	}
	attempts := 0
	for _, step := range detail.Steps {
		attempts += len(step.Attempts)
	}
	if attempts != 5 || attempts > in.Policy.MaxAgentAttempts {
		t.Fatalf("cumulative attempts = %d, want five without a loop reset", attempts)
	}
}

func TestWorkOnTicketNeverMergesAHeadChangedAfterReview(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	recorderStore := storefake.New()
	ticket, err := recorderStore.CreateTicket(ctx, "head changed", "review the new head", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	input := workflows.WorkOnTicketInput{TicketID: ticket.ID, RunID: "019fb901-0000-7000-8000-000000000002", Policy: work.DefaultTargetRunPolicy(), CloneURL: "https://github.com/example/repository.git", Model: work.Model{Name: "gpt-5", Effort: "high"}}
	h := newWorkOnTicketHarness(t, recorderStore)
	h.awaitCI = func(in activities.TargetAwaitCIInput) (activities.AwaitCIOutput, error) {
		if err := h.checkpointRepositoryStep(in.Step); err != nil {
			return activities.AwaitCIOutput{}, err
		}
		return activities.AwaitCIOutput{CommitSHA: in.CI.CommitSHA, Green: true}, nil
	}
	h.mergeResult = func(in activities.TargetMergePullRequestInput) (work.PullRequestMergeResult, error) {
		if len(h.mergeInputs) == 1 {
			return work.PullRequestMergeResult{Outcome: work.PullRequestMergeHeadChanged, PullRequest: work.PullRequest{Number: 1, NodeID: "PR_node1", HeadSHA: "H2"}}, nil
		}
		return work.PullRequestMergeResult{Outcome: work.PullRequestMergeConfirmed, MergeSHA: "M2"}, nil
	}
	h.run(input)
	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("WorkOnTicket: %v", err)
	}
	if len(h.mergeInputs) != 2 || h.mergeInputs[0].ExpectedHeadSHA != "H1" || h.mergeInputs[1].ExpectedHeadSHA != "H2" {
		t.Fatalf("merge requests = %+v, want only H1 then independently authorized H2", h.mergeInputs)
	}
	var reviews []activities.TargetAgentInput
	for _, agent := range h.agentInputs {
		if agent.Stage == work.AgentStageReview {
			reviews = append(reviews, agent)
		}
	}
	if len(reviews) != 2 || reviews[0].PromptContext.CandidateHeadSHA != "H1" || reviews[1].PromptContext.CandidateHeadSHA != "H2" || reviews[0].PriorProviderThread != nil || reviews[1].PriorProviderThread != nil || reviews[1].Prior.LatestReview.Value() == nil || len(reviews[1].Prior.ReviewLedger) != 1 {
		t.Fatalf("review handoffs = %+v, want independent fresh H1 and H2 reviews", reviews)
	}
	detail, err := recorderStore.TargetRunDetail(ctx, input.RunID)
	if err != nil {
		t.Fatalf("TargetRunDetail: %v", err)
	}
	if detail.Run.ReviewedHead != "H2" || detail.Run.MergeSHA != "M2" {
		t.Fatalf("terminal run = %+v, want reviewed H2 / M2", detail.Run)
	}
	for _, step := range detail.Steps {
		if step.Step.Kind == work.StepMergePullRequest && step.Step.State != work.StepStateCompleted {
			t.Fatalf("feedback merge step = %+v, want completed history rather than a stranded running step", step.Step)
		}
	}
}

func TestWorkOnTicketRetriesPendingCIInsideOneStep(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	s := storefake.New()
	ticket, err := s.CreateTicket(ctx, "pending CI", "wait", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	in := workflows.WorkOnTicketInput{TicketID: ticket.ID, RunID: "019fb901-0000-7000-8000-000000000003", Policy: work.DefaultTargetRunPolicy(), CloneURL: "https://github.com/example/repository.git", Model: work.Model{Name: "gpt-5", Effort: "high"}}
	h := newWorkOnTicketHarness(t, s)
	h.awaitCI = func(input activities.TargetAwaitCIInput) (activities.AwaitCIOutput, error) {
		if len(h.ciInputs) == 1 {
			return activities.AwaitCIOutput{}, temporal.NewApplicationErrorWithOptions("checks still pending", activities.ErrTypeCINotConcluded, temporal.ApplicationErrorOptions{NextRetryDelay: 15 * time.Second})
		}
		if err := h.checkpointRepositoryStep(input.Step); err != nil {
			return activities.AwaitCIOutput{}, err
		}
		return activities.AwaitCIOutput{CommitSHA: input.CI.CommitSHA, Green: true}, nil
	}
	h.run(in)
	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("WorkOnTicket: %v", err)
	}
	detail, err := s.TargetRunDetail(ctx, in.RunID)
	if err != nil {
		t.Fatalf("TargetRunDetail: %v", err)
	}
	var ciSteps, attempts int
	for _, step := range detail.Steps {
		if step.Step.Kind == work.StepAwaitCI {
			ciSteps++
		}
		attempts += len(step.Attempts)
	}
	if len(h.ciInputs) != 2 || ciSteps != 1 || attempts != 3 {
		t.Fatalf("pending CI = %d reads, %d CI steps, %d agent attempts; want 2, 1, 3", len(h.ciInputs), ciSteps, attempts)
	}
}

// Credential renewal is supporting machinery for one authorized execution,
// not another Agent Attempt. A long-running implement activity must receive a
// projected credential renewal at thirty minutes while its original activity
// future and durable Attempt remain active.
func TestWorkOnTicketRenewsCredentialDuringOneActiveAgentAttempt(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	s := storefake.New()
	ticket, err := s.CreateTicket(ctx, "renew credentials", "keep Git authenticated", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	in := workflows.WorkOnTicketInput{TicketID: ticket.ID, RunID: "019fb901-0000-7000-8000-000000000008", Policy: work.DefaultTargetRunPolicy(), CloneURL: "https://github.com/example/repository.git", Model: work.Model{Name: "gpt-5", Effort: "high"}}
	h := newWorkOnTicketHarness(t, s)
	implementDone := make(chan struct{})
	h.agentWait = implementDone
	h.env.RegisterDelayedCallback(func() { close(implementDone) }, 31*time.Minute)
	h.run(in)
	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("WorkOnTicket: %v", err)
	}

	detail, err := s.TargetRunDetail(ctx, in.RunID)
	if err != nil {
		t.Fatalf("TargetRunDetail: %v", err)
	}
	attempts := 0
	for _, step := range detail.Steps {
		attempts += len(step.Attempts)
	}
	if attempts != 3 || len(h.rotations) != 4 {
		t.Fatalf("credential renewal = %d durable attempts, %d rotations; want the same three attempts and one 30-minute renewal", attempts, len(h.rotations))
	}
}

// A native retry repeats the activity with its durable Attempt identity. It
// must reconcile that same execution after the projected credential has been
// observed again, rather than authorizing another Attempt or another renewal
// lifecycle.
func TestWorkOnTicketReconcilesNativeAgentRetryWithoutAnotherAttempt(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	s := storefake.New()
	ticket, err := s.CreateTicket(ctx, "retry agent", "reconcile it", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	in := workflows.WorkOnTicketInput{TicketID: ticket.ID, RunID: "019fb901-0000-7000-8000-000000000009", Policy: work.DefaultTargetRunPolicy(), CloneURL: "https://github.com/example/repository.git", Model: work.Model{Name: "gpt-5", Effort: "high"}}
	h := newWorkOnTicketHarness(t, s)
	implementTries := 0
	h.agentResult = func(input activities.TargetAgentInput) (activities.TargetAgentOutput, error) {
		if input.Stage == work.AgentStageImplement {
			implementTries++
			if implementTries == 1 {
				return activities.TargetAgentOutput{}, temporal.NewApplicationError("temporary model transport", activities.ErrTypeTransient, nil)
			}
		}
		return targetAgentOutput(t, input.Stage), nil
	}
	h.run(in)
	if err := h.env.GetWorkflowError(); err != nil {
		t.Fatalf("WorkOnTicket: %v", err)
	}
	var implementInputs []activities.TargetAgentInput
	for _, input := range h.agentInputs {
		if input.Stage == work.AgentStageImplement {
			implementInputs = append(implementInputs, input)
		}
	}
	if len(implementInputs) != 2 || implementInputs[0].AttemptID != implementInputs[1].AttemptID {
		t.Fatalf("implement retry inputs = %+v, want two activity tries of the same durable Agent Attempt", implementInputs)
	}
	detail, err := s.TargetRunDetail(ctx, in.RunID)
	if err != nil {
		t.Fatalf("TargetRunDetail: %v", err)
	}
	attempts := 0
	for _, step := range detail.Steps {
		attempts += len(step.Attempts)
	}
	if attempts != 3 || len(h.rotations) != 3 {
		t.Fatalf("native retry = %d durable attempts, %d credential lifecycles; want three and three", attempts, len(h.rotations))
	}
}

func TestWorkOnTicketStopsBeforeSixthReviewOrTwentySixthAttempt(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	s := storefake.New()
	ticket, err := s.CreateTicket(ctx, "review budget", "find it all", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	in := workflows.WorkOnTicketInput{TicketID: ticket.ID, RunID: "019fb901-0000-7000-8000-000000000004", Policy: work.DefaultTargetRunPolicy(), CloneURL: "https://github.com/example/repository.git", Model: work.Model{Name: "gpt-5", Effort: "high"}}
	h := newWorkOnTicketHarness(t, s)
	h.agentResult = func(input activities.TargetAgentInput) (activities.TargetAgentOutput, error) {
		if input.Stage != work.AgentStageReview {
			return targetAgentOutput(t, input.Stage), nil
		}
		var result work.StageOutput
		if err := json.Unmarshal([]byte(`{"stage":"review","value":{"document":"still blocked","findings":[{"id":"same","blocking":true,"summary":"fix it"}]}}`), &result); err != nil {
			return activities.TargetAgentOutput{}, err
		}
		return activities.TargetAgentOutput{Output: []byte(`{"stage":"review","value":{"document":"still blocked","findings":[{"id":"same","blocking":true,"summary":"fix it"}]}}`), Result: result, ThreadID: "review-thread", UsageState: work.UsageMeasured}, nil
	}
	h.run(in)
	if err := h.env.GetWorkflowError(); err == nil {
		t.Fatal("review-budget workflow succeeded")
	}
	detail, err := s.TargetRunDetail(ctx, in.RunID)
	if err != nil {
		t.Fatalf("TargetRunDetail: %v", err)
	}
	var reviews, attempts, merges int
	for _, step := range detail.Steps {
		if step.Step.Kind == work.StepReview {
			reviews++
		}
		if step.Step.Kind == work.StepMergePullRequest {
			merges++
		}
		attempts += len(step.Attempts)
	}
	if reviews != 5 || attempts > in.Policy.MaxAgentAttempts || merges != 0 {
		t.Fatalf("budget history = %d reviews, %d attempts, %d merges; want five reviews, <=25 attempts, and no merge", reviews, attempts, merges)
	}
}

func TestWorkOnTicketStopsBeforeTwentySixthAgentAttempt(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	s := storefake.New()
	ticket, err := s.CreateTicket(ctx, "attempt budget", "repair CI", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	in := workflows.WorkOnTicketInput{TicketID: ticket.ID, RunID: "019fb901-0000-7000-8000-000000000005", Policy: work.DefaultTargetRunPolicy(), CloneURL: "https://github.com/example/repository.git", Model: work.Model{Name: "gpt-5", Effort: "high"}}
	h := newWorkOnTicketHarness(t, s)
	h.awaitCI = func(input activities.TargetAwaitCIInput) (activities.AwaitCIOutput, error) {
		if err := h.checkpointRepositoryStep(input.Step); err != nil {
			return activities.AwaitCIOutput{}, err
		}
		return activities.AwaitCIOutput{CommitSHA: input.CI.CommitSHA, Green: false, RedFailures: []work.CheckFailure{{Name: "test", Fingerprint: "same", Evidence: "still red"}}}, nil
	}
	h.run(in)
	if err := h.env.GetWorkflowError(); err == nil {
		t.Fatal("agent-attempt-budget workflow succeeded")
	}
	detail, err := s.TargetRunDetail(ctx, in.RunID)
	if err != nil {
		t.Fatalf("TargetRunDetail: %v", err)
	}
	attempts := 0
	for _, step := range detail.Steps {
		attempts += len(step.Attempts)
	}
	if attempts != in.Policy.MaxAgentAttempts || len(h.agentInputs) != in.Policy.MaxAgentAttempts {
		t.Fatalf("agent attempts = %d/%d, want exactly the cap %d and never a twenty-sixth", attempts, len(h.agentInputs), in.Policy.MaxAgentAttempts)
	}
}

func TestWorkOnTicketRepairsTextConflictOrStaleBaseWithFreshReview(t *testing.T) {
	for _, outcome := range []work.PullRequestMergeOutcome{work.PullRequestMergeTextConflict, work.PullRequestMergeBaseRefreshRequired} {
		t.Run(string(outcome), func(t *testing.T) {
			ctx := context.Background()
			s := storefake.New()
			ticket, err := s.CreateTicket(ctx, "merge feedback", "repair it", nil)
			if err != nil {
				t.Fatalf("CreateTicket: %v", err)
			}
			in := workflows.WorkOnTicketInput{TicketID: ticket.ID, RunID: "019fb901-0000-7000-8000-000000000006", Policy: work.DefaultTargetRunPolicy(), CloneURL: "https://github.com/example/repository.git", Model: work.Model{Name: "gpt-5", Effort: "high"}}
			h := newWorkOnTicketHarness(t, s)
			h.sync = func(input activities.TargetSyncPullRequestInput) (work.PullRequest, error) {
				head := "H1"
				if len(h.syncInputs) == 2 {
					head = "H2"
				}
				position := input.Step
				position.PushedHead, position.PullRequestNumber, position.PullRequestNodeID = head, 1, "PR_node1"
				if err := h.checkpointRepositoryStep(position); err != nil {
					return work.PullRequest{}, err
				}
				return work.PullRequest{Number: 1, NodeID: "PR_node1", HeadSHA: head, Draft: true}, nil
			}
			h.awaitCI = func(input activities.TargetAwaitCIInput) (activities.AwaitCIOutput, error) {
				if err := h.checkpointRepositoryStep(input.Step); err != nil {
					return activities.AwaitCIOutput{}, err
				}
				return activities.AwaitCIOutput{CommitSHA: input.CI.CommitSHA, Green: true}, nil
			}
			h.mergeResult = func(input activities.TargetMergePullRequestInput) (work.PullRequestMergeResult, error) {
				if len(h.mergeInputs) == 1 {
					return work.PullRequestMergeResult{Outcome: outcome, PullRequest: work.PullRequest{Number: 1, NodeID: "PR_node1", HeadSHA: "H1", BaseSHA: "B2"}, Diagnostic: "reconcile the branch"}, nil
				}
				return work.PullRequestMergeResult{Outcome: work.PullRequestMergeConfirmed, MergeSHA: "M2"}, nil
			}
			h.run(in)
			if err := h.env.GetWorkflowError(); err != nil {
				t.Fatalf("WorkOnTicket: %v", err)
			}
			var implements, reviews []activities.TargetAgentInput
			for _, agent := range h.agentInputs {
				switch agent.Stage {
				case work.AgentStagePlan:
				case work.AgentStageImplement:
					implements = append(implements, agent)
				case work.AgentStageReview:
					reviews = append(reviews, agent)
				}
			}
			if len(implements) != 2 || implements[1].PriorProviderThread == nil || implements[1].PromptContext.Merge == nil || implements[1].PromptContext.Merge.Outcome != outcome || implements[1].PromptContext.Merge.CurrentBaseSHA != "B2" || implements[1].PromptContext.Merge.Diagnostic != "reconcile the branch" {
				t.Fatalf("merge-feedback implementation = %+v, want same-generation typed %s handoff", implements, outcome)
			}
			if len(reviews) != 2 || reviews[1].PromptContext.CandidateHeadSHA != "H2" || reviews[0].PriorProviderThread != nil || reviews[1].PriorProviderThread != nil {
				t.Fatalf("reviews = %+v, want fresh H1 then H2 reviewers", reviews)
			}
			detail, err := s.TargetRunDetail(ctx, in.RunID)
			if err != nil {
				t.Fatalf("TargetRunDetail: %v", err)
			}
			for _, step := range detail.Steps {
				if step.Step.Kind == work.StepMergePullRequest && step.Step.State != work.StepStateCompleted {
					t.Fatalf("feedback merge step = %+v, want completed history rather than a stranded running step", step.Step)
				}
			}
		})
	}
}

type workOnTicketHarness struct {
	env   *testsuite.TestWorkflowEnvironment
	store *storefake.Store
	runID string

	provisioned activities.ProvisionRunWorkerInput
	clone       activities.CloneTargetRepositoryInput
	rotations   []activities.RotateRunWorkerGitHubCredentialInput
	authorized  []activities.AuthorizeRunWorkerAttemptInput
	agentInputs []activities.TargetAgentInput
	ci          activities.TargetAwaitCIInput
	ready       activities.TargetMarkPullRequestReadyInput
	merge       activities.TargetMergePullRequestInput
	mergeInputs []activities.TargetMergePullRequestInput
	deleted     []activities.DeleteRunWorkerInput
	reviewHead  string

	syncInputs  []activities.TargetSyncPullRequestInput
	ciInputs    []activities.TargetAwaitCIInput
	sync        func(activities.TargetSyncPullRequestInput) (work.PullRequest, error)
	awaitCI     func(activities.TargetAwaitCIInput) (activities.AwaitCIOutput, error)
	mergeResult func(activities.TargetMergePullRequestInput) (work.PullRequestMergeResult, error)
	agentResult func(activities.TargetAgentInput) (activities.TargetAgentOutput, error)
	agentWait   <-chan struct{}
}

func newWorkOnTicketHarness(t *testing.T, recorderStore *storefake.Store) *workOnTicketHarness {
	t.Helper()
	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestWorkflowEnvironment()
	env.SetWorkerOptions(worker.Options{
		EnableSessionWorker:               true,
		MaxConcurrentSessionExecutionSize: 1,
	})
	recording, err := activities.NewTargetRecordingActivities(recorderStore)
	if err != nil {
		t.Fatalf("NewTargetRecordingActivities: %v", err)
	}
	env.RegisterActivity(recording)

	h := &workOnTicketHarness{env: env, store: recorderStore}
	env.RegisterActivityWithOptions(
		func(_ context.Context, in activities.ProvisionRunWorkerInput) (activities.ProvisionRunWorkerOutput, error) {
			h.provisioned = in
			id, err := work.RunWorkerName(in.Identity)
			if err != nil {
				return activities.ProvisionRunWorkerOutput{}, err
			}
			return activities.ProvisionRunWorkerOutput{ID: id}, nil
		},
		activity.RegisterOptions{Name: "ProvisionRunWorker"},
	)
	env.RegisterActivityWithOptions(
		func(_ context.Context, in activities.CloneTargetRepositoryInput) (activities.CloneTargetRepositoryOutput, error) {
			h.clone = in
			position := in.Step
			position.PushedHead = "B0"
			if err := h.checkpointRepositoryStep(position); err != nil {
				return activities.CloneTargetRepositoryOutput{}, err
			}
			return activities.CloneTargetRepositoryOutput{HeadSHA: "B0"}, nil
		},
		activity.RegisterOptions{Name: "CloneTargetRepository"},
	)
	env.RegisterActivityWithOptions(
		func(_ context.Context, in activities.AuthorizeRunWorkerAttemptInput) error {
			h.authorized = append(h.authorized, in)
			return nil
		},
		activity.RegisterOptions{Name: "AuthorizeRunWorkerAttempt"},
	)
	env.RegisterActivityWithOptions(
		func(_ context.Context, in activities.RotateRunWorkerGitHubCredentialInput) (work.RunWorkerCredentialRevision, error) {
			h.rotations = append(h.rotations, in)
			return work.RunWorkerCredentialRevision{Revision: string(rune('1' + len(h.rotations) - 1)), ExpiresAt: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)}, nil
		},
		activity.RegisterOptions{Name: "RotateRunWorkerGitHubCredential"},
	)
	env.RegisterActivityWithOptions(
		func(_ context.Context, in activities.TargetAgentInput) (activities.TargetAgentOutput, error) {
			h.agentInputs = append(h.agentInputs, in)
			if in.Stage == work.AgentStageReview {
				h.reviewHead = in.PromptContext.CandidateHeadSHA
			}
			if h.agentResult != nil {
				return h.agentResult(in)
			}
			if h.agentWait != nil && in.Stage == work.AgentStageImplement {
				<-h.agentWait
			}
			return targetAgentOutput(t, in.Stage), nil
		},
		activity.RegisterOptions{Name: "RunTargetAgent"},
	)
	env.RegisterActivityWithOptions(
		func(_ context.Context, in activities.TargetAwaitCIInput) (activities.AwaitCIOutput, error) {
			h.ciInputs = append(h.ciInputs, in)
			if h.awaitCI != nil {
				return h.awaitCI(in)
			}
			h.ci = in
			if err := h.checkpointRepositoryStep(in.Step); err != nil {
				return activities.AwaitCIOutput{}, err
			}
			return activities.AwaitCIOutput{CommitSHA: "H1", Green: true}, nil
		},
		activity.RegisterOptions{Name: "TargetAwaitCI"},
	)
	env.RegisterActivityWithOptions(
		func(_ context.Context, in activities.TargetSyncPullRequestInput) (work.PullRequest, error) {
			h.syncInputs = append(h.syncInputs, in)
			if h.sync != nil {
				return h.sync(in)
			}
			position := in.Step
			position.PushedHead = "H1"
			position.PullRequestNumber, position.PullRequestNodeID = 1, "PR_node1"
			if err := h.checkpointRepositoryStep(position); err != nil {
				return work.PullRequest{}, err
			}
			return work.PullRequest{Number: 1, NodeID: "PR_node1", HeadSHA: "H1", Draft: true}, nil
		},
		activity.RegisterOptions{Name: "TargetSyncPullRequest"},
	)
	env.RegisterActivityWithOptions(
		func(_ context.Context, in activities.TargetMarkPullRequestReadyInput) error {
			h.ready = in
			return h.checkpointRepositoryStep(in.Step)
		},
		activity.RegisterOptions{Name: "TargetMarkPullRequestReady"},
	)
	env.RegisterActivityWithOptions(
		func(_ context.Context, in activities.TargetMergePullRequestInput) (work.PullRequestMergeResult, error) {
			h.merge = in
			h.mergeInputs = append(h.mergeInputs, in)
			if h.mergeResult != nil {
				result, err := h.mergeResult(in)
				if err != nil || result.Outcome == work.PullRequestMergeConfirmed {
					return result, err
				}
				return result, h.checkpointRepositoryStep(in.Step)
			}
			return work.PullRequestMergeResult{Outcome: work.PullRequestMergeConfirmed, MergeSHA: "M1"}, nil
		},
		activity.RegisterOptions{Name: "TargetMergePullRequest"},
	)
	env.RegisterActivityWithOptions(
		func(_ context.Context, in activities.DeleteRunWorkerInput) error {
			h.deleted = append(h.deleted, in)
			return errors.New("temporary teardown handoff")
		},
		activity.RegisterOptions{Name: "DeleteRunWorker"},
	)
	return h
}

func (h *workOnTicketHarness) run(in workflows.WorkOnTicketInput) {
	h.runID = in.RunID
	h.env.ExecuteWorkflow(workflows.WorkOnTicket, in)
}

func (h *workOnTicketHarness) checkpointRepositoryStep(position activities.RepositoryStep) error {
	_, err := h.store.CheckpointGitEffect(context.Background(), store.GitCheckpointInput{
		GitCheckpoint: store.GitCheckpoint{
			RunID: h.runID, StepOrdinal: position.StepOrdinal, Branch: position.Branch,
			PushedHead: position.PushedHead, ObservedBase: position.ObservedBase,
			PullRequestNumber: position.PullRequestNumber, PullRequestNodeID: position.PullRequestNodeID,
			StepResult: json.RawMessage(`{"kind":"fake"}`),
		},
		CompletedAt: targetTestTime,
	})
	return err
}

var targetTestTime = time.Date(2026, 7, 31, 21, 0, 0, 0, time.UTC)

func targetAgentOutput(t *testing.T, stage work.AgentStage) activities.TargetAgentOutput {
	t.Helper()
	var result work.StageOutput
	var raw string
	switch stage {
	case work.AgentStagePlan:
		raw = `{"stage":"plan","value":{"document":"the plan"}}`
	case work.AgentStageImplement:
		raw = `{"stage":"implement","value":{"report":"implemented","blocked":false,"blockedReason":"","title":"target title","body":"target body"}}`
	case work.AgentStageReview:
		raw = `{"stage":"review","value":{"document":"approved","findings":[]}}`
	default:
		t.Fatalf("unknown target agent stage %q", stage)
	}
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		t.Fatalf("decode %s output: %v", stage, err)
	}
	return activities.TargetAgentOutput{Output: json.RawMessage(raw), Result: result, ThreadID: string(stage) + "-thread", UsageState: work.UsageMeasured}
}
