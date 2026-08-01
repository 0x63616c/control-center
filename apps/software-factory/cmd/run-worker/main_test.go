package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	checkpointprotocol "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/checkpoint"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

type runWorkerTestRedactor struct{}

func (runWorkerTestRedactor) Redact(_ context.Context, raw []byte) ([]byte, error) {
	return bytes.Clone(raw), nil
}

func TestEnsureCodexHomeLinksToProjectedCredentialFile(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home")
	auth := filepath.Join(home, "auth.json")
	projected := filepath.Join(root, "projected", "auth.json")
	if err := os.MkdirAll(filepath.Dir(projected), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(projected, []byte("credential"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ensureCodexHome(home, auth, projected); err != nil {
		t.Fatalf("ensureCodexHome: %v", err)
	}
	target, err := os.Readlink(auth)
	if err != nil {
		t.Fatalf("Readlink: %v", err)
	}
	if target != projected {
		t.Errorf("auth link = %q, want %q", target, projected)
	}
}

func TestRunWorkerRegistersAndExecutesOnePinnedRepositorySession(t *testing.T) {
	t.Parallel()

	identity := work.RunWorkerIdentity{RunID: "0f466627-b3ae-4ba2-9c96-6ef44ec6f578", Generation: 2}
	filesystem := &pinnedFilesystem{identity: identity, marker: "run-worker-generation-2"}
	repository := &sessionRepository{filesystem: filesystem, head: "candidate-head"}
	github := &sessionGitHub{
		filesystem:  filesystem,
		pullRequest: work.PullRequest{Number: 42, NodeID: "PR_kwDO", HeadSHA: "candidate-head", Draft: true},
		mergeResult: work.PullRequestMergeResult{Outcome: work.PullRequestMergeConfirmed, MergeSHA: "merge-head"},
	}
	repositoryCheckpoint := &sessionRepositoryCheckpoint{}
	attemptCheckpoint := &sessionAttemptCheckpoint{}
	target, err := activities.NewRunWorkerActivities(activities.RunWorkerDeps{
		Stages: &sessionStageRunner{filesystem: filesystem, result: work.StageResult{
			Output:   []byte(`{"report":"implemented","blocked":false,"blocked_reason":"","title":"Implement ticket","body":"Ready"}`),
			ThreadID: "thread-42", UsageMeasured: true,
		}},
		Prompts: sessionPrompts{},
		Checkpoints: func(store.TargetAttemptID) (activities.AttemptCheckpoint, error) {
			return attemptCheckpoint, nil
		},
		CredentialRevision: func(context.Context) (string, error) { return "1", nil },
		SecretRedactor:     runWorkerTestRedactor{},
		ProviderState:      sessionProviderState{},
		Clock:              sessionClock{now: time.Date(2026, 7, 31, 20, 0, 0, 0, time.UTC)},
		Heartbeat:          func(context.Context) {},
		Repository:         repository,
		GitHub:             github,
		Identity:           identity,
		RepositoryCheckpoints: func(got work.RunWorkerIdentity) (activities.RepositoryCheckpoint, error) {
			if got != filesystem.identity {
				return nil, fmt.Errorf("repository activity used identity %+v, want %+v", got, filesystem.identity)
			}
			repositoryCheckpoint.identityCalls++
			return repositoryCheckpoint, nil
		},
	})
	if err != nil {
		t.Fatalf("NewRunWorkerActivities: %v", err)
	}

	registrar := &activityRegistrarProbe{}
	register(registrar, &activities.Activities{}, target)
	if got := len(registrar.registrations); got != 4 {
		t.Fatalf("registered activity count = %d, want 4", got)
	}
	registered := registrar.runWorkerActivities(t)

	ctx := context.Background()
	branch := "factory/ticket-42/run"
	clone, err := registered.CloneTargetRepository(ctx, activities.CloneTargetRepositoryInput{
		Step:     activities.RepositoryStep{StepOrdinal: 1, Branch: branch, ObservedBase: "base-head"},
		CloneURL: "https://github.com/example/repo.git",
	})
	if err != nil {
		t.Fatalf("CloneTargetRepository: %v", err)
	}
	if clone.HeadSHA != "candidate-head" {
		t.Fatalf("clone head = %q, want candidate-head", clone.HeadSHA)
	}

	_, err = registered.RunTargetAgent(ctx, activities.TargetAgentInput{
		AttemptID:          store.TargetAttemptID{RunID: identity.RunID, StepOrdinal: 2, AttemptNo: 1},
		TicketNumber:       42,
		Iteration:          1,
		Stage:              work.AgentStageImplement,
		Model:              work.Model{Name: "gpt-5", Effort: "high"},
		CredentialRevision: activities.CredentialRevisionExpectation{Identity: identity, Revision: "1"},
	})
	if err != nil {
		t.Fatalf("RunTargetAgent: %v", err)
	}

	ciStep := activities.RepositoryStep{StepOrdinal: 3, Branch: branch, PushedHead: clone.HeadSHA, ObservedBase: "base-head"}
	ci, err := registered.TargetAwaitCI(ctx, activities.TargetAwaitCIInput{
		Step: ciStep,
		CI:   activities.AwaitCIInput{CommitSHA: clone.HeadSHA, RequiredChecks: []string{"test"}},
	})
	if err != nil {
		t.Fatalf("TargetAwaitCI: %v", err)
	}
	if !ci.Green || ci.CommitSHA != clone.HeadSHA {
		t.Fatalf("CI result = %+v", ci)
	}
	if github.ciHead != clone.HeadSHA {
		t.Fatalf("CI observed head = %q, want %q", github.ciHead, clone.HeadSHA)
	}

	pr, err := registered.TargetSyncPullRequest(ctx, activities.TargetSyncPullRequestInput{
		Step:  activities.RepositoryStep{StepOrdinal: 4, Branch: branch, PushedHead: clone.HeadSHA, ObservedBase: "base-head"},
		Title: "Implement ticket", Body: "Ready",
	})
	if err != nil {
		t.Fatalf("TargetSyncPullRequest: %v", err)
	}
	prStep := activities.RepositoryStep{StepOrdinal: 5, Branch: branch, PushedHead: clone.HeadSHA, ObservedBase: "base-head", PullRequestNumber: pr.Number, PullRequestNodeID: pr.NodeID}
	if err := registered.TargetMarkPullRequestReady(ctx, activities.TargetMarkPullRequestReadyInput{Step: prStep}); err != nil {
		t.Fatalf("TargetMarkPullRequestReady: %v", err)
	}
	if github.readyNode != pr.NodeID {
		t.Fatalf("ready pull request node = %q, want %q", github.readyNode, pr.NodeID)
	}
	merged, err := registered.TargetMergePullRequest(ctx, activities.TargetMergePullRequestInput{Step: activities.RepositoryStep{StepOrdinal: 6, Branch: branch, PushedHead: clone.HeadSHA, ObservedBase: "base-head", PullRequestNumber: pr.Number, PullRequestNodeID: pr.NodeID}, ExpectedHeadSHA: clone.HeadSHA})
	if err != nil {
		t.Fatalf("TargetMergePullRequest: %v", err)
	}
	if merged.Outcome != work.PullRequestMergeConfirmed || github.mergedHead != clone.HeadSHA {
		t.Fatalf("merge result/head = %+v / %q", merged, github.mergedHead)
	}
	if got, want := filesystem.operations, []string{"clone", "agent", "ci", "sync", "ready", "merge"}; !equalStrings(got, want) {
		t.Fatalf("pinned filesystem operations = %v, want %v", got, want)
	}
	if repositoryCheckpoint.identityCalls != 5 {
		t.Fatalf("repository checkpoint identity calls = %d, want 5", repositoryCheckpoint.identityCalls)
	}
}

func TestRunTargetAgentRedactsPriorCredentialAfterProjectionRotation(t *testing.T) {
	t.Parallel()
	identity := work.RunWorkerIdentity{RunID: "0f466627-b3ae-4ba2-9c96-6ef44ec6f578", Generation: 2}
	files := map[string][]byte{
		work.RunWorkerGitHubTokenFile:          []byte("github-token-before-rotation"),
		work.RunWorkerCodexCredentialFile:      []byte(`{"tokens":{"access_token":"codex-access-token","refresh_token":"","id_token":""}}`),
		work.RunWorkerCheckpointCapabilityFile: []byte("checkpoint-capability"),
		work.RunWorkerRepositoryCapabilityFile: []byte("repository-capability"),
	}
	redactor, err := newProjectedSecretRedactor(func(path string) ([]byte, error) { return bytes.Clone(files[path]), nil })
	if err != nil {
		t.Fatalf("newProjectedSecretRedactor: %v", err)
	}
	filesystem := &pinnedFilesystem{identity: identity, marker: "run-worker-generation-2"}
	checkpoint := &sessionAttemptCheckpoint{}
	stage := &sessionStageRunner{
		filesystem: filesystem,
		events:     [][]byte{[]byte(`{"type":"thread.started","thread_id":"thread-42"}`), []byte(`{"type":"item.completed","item":{"text":"github-token-before-rotation"}}`)},
		afterEvents: func() {
			files[work.RunWorkerGitHubTokenFile] = []byte("github-token-after-rotation")
		},
		result: work.StageResult{
			Output:   []byte(`{"report":"github-token-before-rotation github-token-after-rotation","blocked":false,"blocked_reason":"","title":"Implement ticket","body":"Ready"}`),
			ThreadID: "thread-42", UsageMeasured: true,
		},
	}
	target, err := activities.NewRunWorkerActivities(activities.RunWorkerDeps{
		Stages: stage, Prompts: sessionPrompts{}, Checkpoints: func(store.TargetAttemptID) (activities.AttemptCheckpoint, error) { return checkpoint, nil },
		CredentialRevision: func(context.Context) (string, error) { return "1", nil }, SecretRedactor: redactor,
		ProviderState: sessionProviderState{}, Clock: sessionClock{now: time.Date(2026, 7, 31, 20, 0, 0, 0, time.UTC)}, Heartbeat: func(context.Context) {},
		Repository: &sessionRepository{filesystem: filesystem, head: "candidate-head"}, GitHub: &sessionGitHub{filesystem: filesystem}, Identity: identity,
		RepositoryCheckpoints: func(work.RunWorkerIdentity) (activities.RepositoryCheckpoint, error) {
			return &sessionRepositoryCheckpoint{}, nil
		},
	})
	if err != nil {
		t.Fatalf("NewRunWorkerActivities: %v", err)
	}
	out, err := target.RunTargetAgent(context.Background(), activities.TargetAgentInput{
		AttemptID: store.TargetAttemptID{RunID: identity.RunID, StepOrdinal: 2, AttemptNo: 1}, TicketNumber: 42, Iteration: 1,
		Stage: work.AgentStageImplement, Model: work.Model{Name: "gpt-5", Effort: "high"},
		CredentialRevision: activities.CredentialRevisionExpectation{Identity: identity, Revision: "1"},
	})
	if err != nil {
		t.Fatalf("RunTargetAgent: %v", err)
	}
	for _, secret := range [][]byte{[]byte("github-token-before-rotation"), []byte("github-token-after-rotation")} {
		if bytes.Contains(out.Output, secret) || bytes.Contains([]byte(out.Result.Prose()), secret) {
			t.Fatalf("activity output leaked %q: %+v", secret, out)
		}
		for _, write := range checkpoint.writes {
			if bytes.Contains(write.Result, secret) {
				t.Fatalf("checkpoint result leaked %q: %s", secret, write.Result)
			}
			if write.Transcript != nil && bytes.Contains(decompressRunWorkerTranscript(t, write.Transcript.CompressedBytes), secret) {
				t.Fatalf("checkpoint transcript leaked %q", secret)
			}
		}
	}
}

func decompressRunWorkerTranscript(t *testing.T, compressed []byte) []byte {
	t.Helper()
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		t.Fatalf("opening compressed transcript: %v", err)
	}
	defer func() { _ = reader.Close() }()
	raw, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("reading compressed transcript: %v", err)
	}
	return raw
}

type activityRegistrarProbe struct{ registrations []any }

func (p *activityRegistrarProbe) RegisterActivity(activity any) {
	p.registrations = append(p.registrations, activity)
}

func (p *activityRegistrarProbe) runWorkerActivities(t *testing.T) *activities.RunWorkerActivities {
	t.Helper()
	for _, registration := range p.registrations {
		if target, ok := registration.(*activities.RunWorkerActivities); ok {
			return target
		}
	}
	t.Fatal("register did not register RunWorkerActivities")
	return nil
}

type pinnedFilesystem struct {
	identity   work.RunWorkerIdentity
	marker     string
	operations []string
}

func (f *pinnedFilesystem) observe(operation string) error {
	if f.marker == "" {
		return fmt.Errorf("%s did not observe the pinned filesystem marker", operation)
	}
	f.operations = append(f.operations, operation)
	return nil
}

type sessionRepository struct {
	filesystem *pinnedFilesystem
	head       string
}

func (r *sessionRepository) Prepare(_ context.Context, _, _ string) (string, error) {
	if err := r.filesystem.observe("clone"); err != nil {
		return "", err
	}
	return r.head, nil
}

type sessionStageRunner struct {
	filesystem  *pinnedFilesystem
	result      work.StageResult
	events      [][]byte
	afterEvents func()
}

func (r *sessionStageRunner) RunTargetStage(_ context.Context, _ work.StageRun, _ string, events work.StageEventSink) (work.StageResult, error) {
	if err := r.filesystem.observe("agent"); err != nil {
		return work.StageResult{}, err
	}
	stream := r.events
	if len(stream) == 0 {
		stream = [][]byte{[]byte(`{"type":"thread.started","thread_id":"thread-42"}`)}
	}
	for _, event := range stream {
		events(event)
	}
	if r.afterEvents != nil {
		r.afterEvents()
	}
	return r.result, nil
}

type sessionPrompts struct{}

func (sessionPrompts) Render(work.StageKey, work.TicketDetail, work.PriorTurns, work.AgentPromptContext, int) (string, []byte, error) {
	return "prompt", []byte(`{}`), nil
}

func (sessionPrompts) Decode(stage work.Stage, raw []byte) (work.StageOutput, error) {
	var output work.ImplementOutput
	if err := json.Unmarshal(raw, &output); err != nil {
		return work.StageOutput{}, err
	}
	return work.NewStageOutput(stage, output), nil
}

type sessionAttemptCheckpoint struct {
	value  checkpointprotocol.Attempt
	found  bool
	writes []checkpointprotocol.Attempt
}

func (c *sessionAttemptCheckpoint) Load(context.Context) (checkpointprotocol.Attempt, bool, error) {
	return c.value, c.found, nil
}

func (c *sessionAttemptCheckpoint) Checkpoint(_ context.Context, value checkpointprotocol.Attempt) error {
	c.value, c.found = value, true
	c.writes = append(c.writes, value)
	return nil
}

type sessionProviderState struct{}

func (sessionProviderState) Available(context.Context, string) (bool, error) { return true, nil }

type sessionClock struct{ now time.Time }

func (c sessionClock) Now() time.Time { return c.now }

type sessionRepositoryCheckpoint struct {
	value         store.GitCheckpoint
	found         bool
	identityCalls int
}

func (c *sessionRepositoryCheckpoint) Load(context.Context) (store.GitCheckpoint, bool, error) {
	return c.value, c.found, nil
}

func (c *sessionRepositoryCheckpoint) Checkpoint(_ context.Context, value store.GitCheckpointInput) (store.GitCheckpoint, error) {
	c.value, c.found = value.GitCheckpoint, true
	return c.value, nil
}

func (c *sessionRepositoryCheckpoint) CheckpointEffect(_ context.Context, value store.GitCheckpointInput) (store.GitCheckpoint, error) {
	c.value, c.found = value.GitCheckpoint, true
	return c.value, nil
}

type sessionGitHub struct {
	filesystem  *pinnedFilesystem
	pullRequest work.PullRequest
	mergeResult work.PullRequestMergeResult
	ciHead      string
	readyNode   string
	mergedHead  string
}

func (g *sessionGitHub) PullRequestForBranch(context.Context, string) (work.PullRequest, bool, error) {
	return g.pullRequest, true, nil
}

func (g *sessionGitHub) OpenOrUpdatePullRequest(context.Context, string, string, string, *work.PullRequest) (work.PullRequest, error) {
	if err := g.filesystem.observe("sync"); err != nil {
		return work.PullRequest{}, err
	}
	return g.pullRequest, nil
}

func (g *sessionGitHub) MarkPullRequestReadyForReview(_ context.Context, nodeID string) error {
	g.readyNode = nodeID
	return g.filesystem.observe("ready")
}

func (g *sessionGitHub) MergePullRequest(_ context.Context, _ int, head string) (work.PullRequestMergeResult, error) {
	if err := g.filesystem.observe("merge"); err != nil {
		return work.PullRequestMergeResult{}, err
	}
	g.mergedHead = head
	return g.mergeResult, nil
}

func (g *sessionGitHub) ChecksForCommit(_ context.Context, head string, _ []string) ([]work.CheckRun, error) {
	if err := g.filesystem.observe("ci"); err != nil {
		return nil, err
	}
	g.ciHead = head
	return []work.CheckRun{{Name: "test", Completed: true, Conclusion: "success"}}, nil
}

func equalStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
