package activities

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	checkpointprotocol "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/checkpoint"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

type attemptCheckpointProbe struct {
	loaded checkpointprotocol.Attempt
	found  bool
	writes []checkpointprotocol.Attempt
}

func (p *attemptCheckpointProbe) Load(context.Context) (checkpointprotocol.Attempt, bool, error) {
	return p.loaded, p.found, nil
}

func (p *attemptCheckpointProbe) Checkpoint(_ context.Context, in checkpointprotocol.Attempt) error {
	p.writes = append(p.writes, in)
	return nil
}

type targetStageRunnerProbe struct {
	calls  int
	resume string
	result work.StageResult
}

func (p *targetStageRunnerProbe) RunTargetStage(_ context.Context, _ work.StageRun, resume string, events work.StageEventSink) (work.StageResult, error) {
	p.calls++
	p.resume = resume
	events([]byte(`{"type":"thread.started","thread_id":"thread-live"}`))
	events([]byte(`{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":2}}`))
	return p.result, nil
}

type providerStateProbe struct{ available bool }

func (p providerStateProbe) Available(context.Context, string) (bool, error) { return p.available, nil }

type promptProbe struct{}

func (promptProbe) Render(work.StageKey, work.TicketDetail, work.PriorTurns) (string, []byte, error) {
	return "prompt", []byte(`{}`), nil
}

func (promptProbe) Decode(_ work.Stage, result []byte) (work.StageOutput, error) {
	return work.StageOutput{}, nil
}

func targetAgentInput() TargetAgentInput {
	return TargetAgentInput{
		AttemptID:    store.TargetAttemptID{RunID: "0f466627-b3ae-4ba2-9c96-6ef44ec6f578", StepOrdinal: 4, AttemptNo: 1},
		TicketNumber: 42, Iteration: 1, Stage: work.AgentStageImplement,
		Model: work.Model{Name: "gpt-5", Effort: "high"},
	}
}

func TestRunTargetAgentReturnsCompletedCheckpointWithoutModelCall(t *testing.T) {
	t.Parallel()
	endedAt := time.Date(2026, 7, 31, 20, 0, 0, 0, time.UTC)
	cp := &attemptCheckpointProbe{found: true, loaded: checkpointprotocol.Attempt{ProviderThreadID: "thread-done", State: work.AgentAttemptSucceeded, UsageState: work.UsageMeasured, EndedAt: &endedAt, Result: json.RawMessage(`{"document":"done"}`)}}
	runner := &targetStageRunnerProbe{}
	a, err := NewRunWorkerActivities(RunWorkerDeps{Stages: runner, Prompts: promptProbe{}, Checkpoints: func(store.TargetAttemptID) (AttemptCheckpoint, error) { return cp, nil }, ProviderState: providerStateProbe{available: true}, Clock: fixedClock{now: endedAt}, Heartbeat: func(context.Context) {}, Repository: &targetRepositoryProbe{}, GitHub: &targetGitHubProbe{}, Identity: targetTestIdentity, RepositoryCheckpoints: testRepositoryCheckpointFactory})
	if err != nil {
		t.Fatalf("NewRunWorkerActivities: %v", err)
	}
	out, err := a.RunTargetAgent(context.Background(), targetAgentInput())
	if err != nil {
		t.Fatalf("RunTargetAgent: %v", err)
	}
	if runner.calls != 0 || out.ThreadID != "thread-done" || string(out.Output) != `{"document":"done"}` {
		t.Fatalf("result = %+v, runner calls %d", out, runner.calls)
	}
}

func TestRunTargetAgentRefusesFreshExecutionForUnresumableCheckpoint(t *testing.T) {
	t.Parallel()
	cp := &attemptCheckpointProbe{found: true, loaded: checkpointprotocol.Attempt{ProviderThreadID: "thread-lost", State: work.AgentAttemptRunning, UsageState: work.UsageUnknown}}
	runner := &targetStageRunnerProbe{}
	a, err := NewRunWorkerActivities(RunWorkerDeps{Stages: runner, Prompts: promptProbe{}, Checkpoints: func(store.TargetAttemptID) (AttemptCheckpoint, error) { return cp, nil }, ProviderState: providerStateProbe{}, Clock: fixedClock{now: time.Date(2026, 7, 31, 20, 0, 0, 0, time.UTC)}, Heartbeat: func(context.Context) {}, Repository: &targetRepositoryProbe{}, GitHub: &targetGitHubProbe{}, Identity: targetTestIdentity, RepositoryCheckpoints: testRepositoryCheckpointFactory})
	if err != nil {
		t.Fatalf("NewRunWorkerActivities: %v", err)
	}
	_, err = a.RunTargetAgent(context.Background(), targetAgentInput())
	if !errors.Is(err, ErrUnresumableIncompleteAttempt) || runner.calls != 0 {
		t.Fatalf("error = %v, runner calls %d", err, runner.calls)
	}
}

func TestRunTargetAgentCheckpointsProviderAndTerminalBeforeSuccess(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 7, 31, 20, 0, 0, 0, time.UTC)
	cp := &attemptCheckpointProbe{}
	runner := &targetStageRunnerProbe{result: work.StageResult{Output: []byte(`{"document":"done"}`), ThreadID: "thread-live", Usage: work.Usage{InputTokens: 3, OutputTokens: 2}, UsageMeasured: true}}
	a, err := NewRunWorkerActivities(RunWorkerDeps{Stages: runner, Prompts: promptProbe{}, Checkpoints: func(store.TargetAttemptID) (AttemptCheckpoint, error) { return cp, nil }, ProviderState: providerStateProbe{available: true}, Clock: fixedClock{now: now}, Heartbeat: func(context.Context) {}, Repository: &targetRepositoryProbe{}, GitHub: &targetGitHubProbe{}, Identity: targetTestIdentity, RepositoryCheckpoints: testRepositoryCheckpointFactory})
	if err != nil {
		t.Fatalf("NewRunWorkerActivities: %v", err)
	}
	if _, err := a.RunTargetAgent(context.Background(), targetAgentInput()); err != nil {
		t.Fatalf("RunTargetAgent: %v", err)
	}
	if len(cp.writes) != 2 || cp.writes[0].State != work.AgentAttemptRunning || cp.writes[0].ProviderThreadID != "thread-live" || cp.writes[1].State != work.AgentAttemptSucceeded || cp.writes[1].Transcript == nil || string(cp.writes[1].Result) != `{"document":"done"}` {
		t.Fatalf("checkpoint writes = %+v", cp.writes)
	}
}

type fixedClock struct{ now time.Time }

func (c fixedClock) Now() time.Time { return c.now }
