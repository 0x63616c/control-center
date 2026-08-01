package activities

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

var targetTestIdentity = work.RunWorkerIdentity{RunID: "0f466627-b3ae-4ba2-9c96-6ef44ec6f578", Generation: 1}

type targetRepositoryProbe struct {
	url, branch string
	head        string
	calls       int
}

func (p *targetRepositoryProbe) Prepare(_ context.Context, url, branch string) (string, error) {
	p.calls++
	p.url, p.branch = url, branch
	return p.head, nil
}

type targetGitHubProbe struct {
	commitSHA  string
	required   []string
	checks     []work.CheckRun
	pr         work.PullRequest
	merge      work.PullRequestMergeResult
	syncCalls  int
	readyCalls int
	mergeCalls int
}

func (p *targetGitHubProbe) PullRequestForBranch(context.Context, string) (work.PullRequest, bool, error) {
	return p.pr, p.pr.Number != 0, nil
}
func (p *targetGitHubProbe) OpenOrUpdatePullRequest(_ context.Context, _, _, _ string, _ *work.PullRequest) (work.PullRequest, error) {
	p.syncCalls++
	return p.pr, nil
}
func (p *targetGitHubProbe) MarkPullRequestReadyForReview(context.Context, string) error {
	p.readyCalls++
	return nil
}
func (p *targetGitHubProbe) MergePullRequest(_ context.Context, _ int, sha string) (work.PullRequestMergeResult, error) {
	p.mergeCalls++
	p.commitSHA = sha
	return p.merge, nil
}
func (p *targetGitHubProbe) ChecksForCommit(_ context.Context, sha string, required []string) ([]work.CheckRun, error) {
	p.commitSHA, p.required = sha, append([]string(nil), required...)
	return p.checks, nil
}

type repositoryCheckpointProbe struct {
	loaded store.GitCheckpoint
	found  bool
	writes []store.GitCheckpointInput
}

func (p *repositoryCheckpointProbe) Load(context.Context) (store.GitCheckpoint, bool, error) {
	return p.loaded, p.found, nil
}
func (p *repositoryCheckpointProbe) Checkpoint(_ context.Context, in store.GitCheckpointInput) (store.GitCheckpoint, error) {
	p.writes = append(p.writes, in)
	return in.GitCheckpoint, nil
}

func targetRepositoryActivities(repository *targetRepositoryProbe, github *targetGitHubProbe, cp *repositoryCheckpointProbe) *RunWorkerActivities {
	return &RunWorkerActivities{deps: RunWorkerDeps{
		Repository: repository, GitHub: github, Identity: targetTestIdentity,
		RepositoryCheckpoints: func(work.RunWorkerIdentity) (RepositoryCheckpoint, error) { return cp, nil },
		Clock:                 fixedClock{now: time.Date(2026, 7, 31, 20, 0, 0, 0, time.UTC)},
	}}
}

func testRepositoryCheckpointFactory(work.RunWorkerIdentity) (RepositoryCheckpoint, error) {
	return &repositoryCheckpointProbe{}, nil
}

func targetPosition(ordinal int) RepositoryStep {
	return RepositoryStep{StepOrdinal: ordinal, Branch: "factory/ticket-42/run", PushedHead: "candidate-sha", ObservedBase: "base-sha", PullRequestNumber: 42, PullRequestNodeID: "PR_node"}
}

func TestCloneTargetRepositoryCompletesTheInfrastructureStepBeforeSuccess(t *testing.T) {
	repository := &targetRepositoryProbe{head: "head-sha"}
	cp := &repositoryCheckpointProbe{}
	a := targetRepositoryActivities(repository, &targetGitHubProbe{}, cp)
	in := CloneTargetRepositoryInput{Step: RepositoryStep{StepOrdinal: 1, Branch: "factory/ticket-42/run", ObservedBase: "base-sha"}, CloneURL: "https://github.com/example/repo.git"}
	out, err := a.CloneTargetRepository(context.Background(), in)
	if err != nil {
		t.Fatalf("CloneTargetRepository: %v", err)
	}
	if repository.url != in.CloneURL || repository.branch != in.Step.Branch || out.HeadSHA != "head-sha" || len(cp.writes) != 1 || cp.writes[0].PushedHead != "head-sha" {
		t.Fatalf("clone/checkpoint = %+v / %+v / %+v", repository, out, cp.writes)
	}
}

func TestCloneRecoveryRestoresReplacementFilesystemWithoutRepeatingTheCompletedEffect(t *testing.T) {
	position := RepositoryStep{StepOrdinal: 1, Branch: "factory/ticket-42/run", ObservedBase: "base-sha"}
	cp := storedRepositoryEffect(t, RepositoryStep{StepOrdinal: 1, Branch: position.Branch, PushedHead: "generation-one-head", ObservedBase: position.ObservedBase}, repositoryEffectClone, CloneTargetRepositoryOutput{HeadSHA: "generation-one-head"})
	repository := &targetRepositoryProbe{head: "latest-pushed-head"}
	a := targetRepositoryActivities(repository, &targetGitHubProbe{}, cp)
	out, err := a.CloneTargetRepository(context.Background(), CloneTargetRepositoryInput{Step: position, CloneURL: "https://github.com/example/repo.git"})
	if err != nil {
		t.Fatalf("CloneTargetRepository replacement: %v", err)
	}
	if repository.calls != 1 || out.HeadSHA != "generation-one-head" || len(cp.writes) != 0 {
		t.Fatalf("replacement restore/result/writes = %d / %+v / %+v", repository.calls, out, cp.writes)
	}
}

func TestTargetAwaitCIUsesTheExactCommitAndCompletesItsStep(t *testing.T) {
	github := &targetGitHubProbe{checks: []work.CheckRun{{Name: "test", Completed: true, Conclusion: "success"}}}
	cp := &repositoryCheckpointProbe{}
	a := targetRepositoryActivities(&targetRepositoryProbe{}, github, cp)
	out, err := a.TargetAwaitCI(context.Background(), TargetAwaitCIInput{Step: targetPosition(2), CI: AwaitCIInput{CommitSHA: "candidate-sha", RequiredChecks: []string{"test"}}})
	if err != nil {
		t.Fatalf("TargetAwaitCI: %v", err)
	}
	if github.commitSHA != "candidate-sha" || len(github.required) != 1 || !out.Green || len(cp.writes) != 1 {
		t.Fatalf("CI/checkpoint = %+v / %+v / %+v", github, out, cp.writes)
	}
}

func TestTargetSyncRetryAfterAcceptedEffectUsesTheExactDurableResult(t *testing.T) {
	position := targetPosition(3)
	want := work.PullRequest{Number: 42, NodeID: "PR_node", URL: "https://github.com/example/repo/pull/42"}
	cp := storedRepositoryEffect(t, position, repositoryEffectSync, want)
	github := &targetGitHubProbe{pr: work.PullRequest{Number: 99}}
	a := targetRepositoryActivities(&targetRepositoryProbe{}, github, cp)
	got, err := a.TargetSyncPullRequest(context.Background(), TargetSyncPullRequestInput{Step: position, Title: "title"})
	if err != nil {
		t.Fatalf("TargetSyncPullRequest: %v", err)
	}
	if github.syncCalls != 0 || got.Number != want.Number || got.NodeID != want.NodeID {
		t.Fatalf("sync calls/result = %d / %+v", github.syncCalls, got)
	}
}

func TestTargetReadyRetryAfterAcceptedEffectDoesNotCallGitHubAgain(t *testing.T) {
	position := targetPosition(4)
	cp := storedRepositoryEffect(t, position, repositoryEffectReady, struct{}{})
	github := &targetGitHubProbe{}
	a := targetRepositoryActivities(&targetRepositoryProbe{}, github, cp)
	if err := a.TargetMarkPullRequestReady(context.Background(), TargetMarkPullRequestReadyInput{Step: position}); err != nil {
		t.Fatalf("TargetMarkPullRequestReady: %v", err)
	}
	if github.readyCalls != 0 {
		t.Fatalf("ready retried GitHub %d times", github.readyCalls)
	}
}

func TestTargetMergeRetryAfterAcceptedEffectDoesNotMergeAgain(t *testing.T) {
	position := targetPosition(5)
	want := work.PullRequestMergeResult{Outcome: work.PullRequestMergeConfirmed, MergeSHA: "merge-sha"}
	cp := storedRepositoryEffect(t, position, repositoryEffectMerge, want)
	github := &targetGitHubProbe{}
	a := targetRepositoryActivities(&targetRepositoryProbe{}, github, cp)
	got, err := a.TargetMergePullRequest(context.Background(), TargetMergePullRequestInput{Step: position, ExpectedHeadSHA: position.PushedHead})
	if err != nil {
		t.Fatalf("TargetMergePullRequest: %v", err)
	}
	if github.mergeCalls != 0 || got.Outcome != want.Outcome || got.MergeSHA != want.MergeSHA {
		t.Fatalf("merge calls/result = %d / %+v", github.mergeCalls, got)
	}
}

func TestRepositoryCheckpointForAnotherEffectCannotShortCircuit(t *testing.T) {
	position := targetPosition(6)
	cp := storedRepositoryEffect(t, position, repositoryEffectSync, work.PullRequest{Number: 42})
	github := &targetGitHubProbe{}
	a := targetRepositoryActivities(&targetRepositoryProbe{}, github, cp)
	if _, err := a.TargetMergePullRequest(context.Background(), TargetMergePullRequestInput{Step: position, ExpectedHeadSHA: position.PushedHead}); err == nil {
		t.Fatal("merge accepted a sync checkpoint from the same Step")
	}
	if github.mergeCalls != 0 {
		t.Fatal("mismatched durable effect reached GitHub")
	}
}

func storedRepositoryEffect(t *testing.T, position RepositoryStep, kind string, result any) *repositoryCheckpointProbe {
	t.Helper()
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := json.Marshal(repositoryEffectEnvelope{Kind: kind, Result: raw})
	if err != nil {
		t.Fatal(err)
	}
	return &repositoryCheckpointProbe{found: true, loaded: store.GitCheckpoint{
		RunID: targetTestIdentity.RunID, StepOrdinal: position.StepOrdinal, Branch: position.Branch,
		PushedHead: position.PushedHead, ObservedBase: position.ObservedBase,
		PullRequestNumber: position.PullRequestNumber, PullRequestNodeID: position.PullRequestNodeID, StepResult: envelope,
	}}
}
