package activities

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"testing"
	"time"

	checkpointprotocol "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/checkpoint"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/sdk/temporal"
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
	events [][]byte
	err    error
}

func (p *targetStageRunnerProbe) RunTargetStage(_ context.Context, _ work.StageRun, resume string, events work.StageEventSink) (work.StageResult, error) {
	p.calls++
	p.resume = resume
	if len(p.events) > 0 {
		for _, event := range p.events {
			events(event)
		}
		return p.result, p.err
	}
	events([]byte(`{"type":"thread.started","thread_id":"thread-live"}`))
	events([]byte(`{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":2}}`))
	return p.result, p.err
}

type exactSecretRedactorProbe struct{ values [][]byte }

func (p exactSecretRedactorProbe) Redact(_ context.Context, raw []byte) ([]byte, error) {
	redacted := bytes.Clone(raw)
	for _, value := range p.values {
		redacted = bytes.ReplaceAll(redacted, value, []byte("[redacted]"))
	}
	return redacted, nil
}

type passthroughSecretRedactor struct{}

func (passthroughSecretRedactor) Redact(_ context.Context, raw []byte) ([]byte, error) {
	return bytes.Clone(raw), nil
}

type invalidatingSecretRedactor struct{ exactSecretRedactorProbe }

func (p invalidatingSecretRedactor) Redact(ctx context.Context, raw []byte) ([]byte, error) {
	if bytes.Contains(raw, []byte(`"report"`)) {
		return []byte("not-json"), nil
	}
	return p.exactSecretRedactorProbe.Redact(ctx, raw)
}

type validatingPromptProbe struct{}

func (validatingPromptProbe) Render(work.StageKey, work.TicketDetail, work.PriorTurns) (string, []byte, error) {
	return "prompt", []byte(`{}`), nil
}

func (validatingPromptProbe) Decode(_ work.Stage, raw []byte) (work.StageOutput, error) {
	if !json.Valid(raw) {
		return work.StageOutput{}, fmt.Errorf("invalid result %s", raw)
	}
	return work.StageOutput{}, nil
}

type providerStateProbe struct{ available bool }

func (p providerStateProbe) Available(context.Context, string) (bool, error) { return p.available, nil }

type credentialRevisionProbe struct {
	revision string
	calls    int
}

func (p *credentialRevisionProbe) Observe(context.Context) (string, error) {
	p.calls++
	return p.revision, nil
}

func observedCredentialRevision(context.Context) (string, error) { return "1", nil }

type promptProbe struct{}

func (promptProbe) Render(work.StageKey, work.TicketDetail, work.PriorTurns) (string, []byte, error) {
	return "prompt", []byte(`{}`), nil
}

func (promptProbe) Decode(_ work.Stage, result []byte) (work.StageOutput, error) {
	return work.StageOutput{}, nil
}

func targetAgentInput() TargetAgentInput {
	return TargetAgentInput{
		AttemptID:          store.TargetAttemptID{RunID: "0f466627-b3ae-4ba2-9c96-6ef44ec6f578", StepOrdinal: 4, AttemptNo: 1},
		TicketNumber:       42,
		Iteration:          1,
		Stage:              work.AgentStageImplement,
		Model:              work.Model{Name: "gpt-5", Effort: "high"},
		CredentialRevision: CredentialRevisionExpectation{Identity: targetTestIdentity, Revision: "1"},
	}
}

func TestRunTargetAgentReturnsCompletedCheckpointWithoutModelCall(t *testing.T) {
	t.Parallel()
	endedAt := time.Date(2026, 7, 31, 20, 0, 0, 0, time.UTC)
	cp := &attemptCheckpointProbe{found: true, loaded: checkpointprotocol.Attempt{ProviderThreadID: "thread-done", State: work.AgentAttemptSucceeded, UsageState: work.UsageMeasured, EndedAt: &endedAt, Result: json.RawMessage(`{"document":"done"}`)}}
	runner := &targetStageRunnerProbe{}
	a, err := NewRunWorkerActivities(RunWorkerDeps{Stages: runner, Prompts: promptProbe{}, Checkpoints: func(store.TargetAttemptID) (AttemptCheckpoint, error) { return cp, nil }, CredentialRevision: observedCredentialRevision, SecretRedactor: passthroughSecretRedactor{}, ProviderState: providerStateProbe{available: true}, Clock: fixedClock{now: endedAt}, Heartbeat: func(context.Context) {}, Repository: &targetRepositoryProbe{}, GitHub: &targetGitHubProbe{}, Identity: targetTestIdentity, RepositoryCheckpoints: testRepositoryCheckpointFactory})
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
	a, err := NewRunWorkerActivities(RunWorkerDeps{Stages: runner, Prompts: promptProbe{}, Checkpoints: func(store.TargetAttemptID) (AttemptCheckpoint, error) { return cp, nil }, CredentialRevision: observedCredentialRevision, SecretRedactor: passthroughSecretRedactor{}, ProviderState: providerStateProbe{}, Clock: fixedClock{now: time.Date(2026, 7, 31, 20, 0, 0, 0, time.UTC)}, Heartbeat: func(context.Context) {}, Repository: &targetRepositoryProbe{}, GitHub: &targetGitHubProbe{}, Identity: targetTestIdentity, RepositoryCheckpoints: testRepositoryCheckpointFactory})
	if err != nil {
		t.Fatalf("NewRunWorkerActivities: %v", err)
	}
	_, err = a.RunTargetAgent(context.Background(), targetAgentInput())
	if !errors.Is(err, ErrUnresumableIncompleteAttempt) || runner.calls != 0 {
		t.Fatalf("error = %v, runner calls %d", err, runner.calls)
	}
}

func TestRunTargetAgentResumesPriorImplementerThreadOnTheSameWorkerGeneration(t *testing.T) {
	t.Parallel()
	cp := &attemptCheckpointProbe{}
	runner := &targetStageRunnerProbe{}
	a, err := NewRunWorkerActivities(RunWorkerDeps{Stages: runner, Prompts: promptProbe{}, Checkpoints: func(store.TargetAttemptID) (AttemptCheckpoint, error) { return cp, nil }, CredentialRevision: observedCredentialRevision, SecretRedactor: passthroughSecretRedactor{}, ProviderState: providerStateProbe{available: true}, Clock: fixedClock{now: time.Date(2026, 7, 31, 20, 0, 0, 0, time.UTC)}, Heartbeat: func(context.Context) {}, Repository: &targetRepositoryProbe{}, GitHub: &targetGitHubProbe{}, Identity: targetTestIdentity, RepositoryCheckpoints: testRepositoryCheckpointFactory})
	if err != nil {
		t.Fatalf("NewRunWorkerActivities: %v", err)
	}
	in := targetAgentInput()
	in.AttemptID.StepOrdinal++
	in.PriorProviderThread = &ProviderThreadContinuation{Identity: targetTestIdentity, ThreadID: "thread-established"}
	if _, err := a.RunTargetAgent(context.Background(), in); err != nil {
		t.Fatalf("RunTargetAgent: %v", err)
	}
	if runner.calls != 1 || runner.resume != "thread-established" {
		t.Fatalf("runner calls/resume = %d / %q", runner.calls, runner.resume)
	}
}

func TestRunTargetAgentRefusesPriorImplementerThreadFromReplacementGeneration(t *testing.T) {
	t.Parallel()
	runner := &targetStageRunnerProbe{}
	a, err := NewRunWorkerActivities(RunWorkerDeps{Stages: runner, Prompts: promptProbe{}, Checkpoints: func(store.TargetAttemptID) (AttemptCheckpoint, error) { return &attemptCheckpointProbe{}, nil }, CredentialRevision: observedCredentialRevision, SecretRedactor: passthroughSecretRedactor{}, ProviderState: providerStateProbe{available: true}, Clock: fixedClock{now: time.Date(2026, 7, 31, 20, 0, 0, 0, time.UTC)}, Heartbeat: func(context.Context) {}, Repository: &targetRepositoryProbe{}, GitHub: &targetGitHubProbe{}, Identity: targetTestIdentity, RepositoryCheckpoints: testRepositoryCheckpointFactory})
	if err != nil {
		t.Fatalf("NewRunWorkerActivities: %v", err)
	}
	in := targetAgentInput()
	in.PriorProviderThread = &ProviderThreadContinuation{Identity: work.RunWorkerIdentity{RunID: targetTestIdentity.RunID, Generation: targetTestIdentity.Generation + 1}, ThreadID: "thread-lost"}
	_, err = a.RunTargetAgent(context.Background(), in)
	if !errors.Is(err, ErrUnresumableIncompleteAttempt) || runner.calls != 0 {
		t.Fatalf("error/calls = %v / %d", err, runner.calls)
	}
}

func TestRunTargetAgentRefusesUnavailablePriorImplementerThread(t *testing.T) {
	t.Parallel()
	runner := &targetStageRunnerProbe{}
	a, err := NewRunWorkerActivities(RunWorkerDeps{Stages: runner, Prompts: promptProbe{}, Checkpoints: func(store.TargetAttemptID) (AttemptCheckpoint, error) { return &attemptCheckpointProbe{}, nil }, CredentialRevision: observedCredentialRevision, SecretRedactor: passthroughSecretRedactor{}, ProviderState: providerStateProbe{}, Clock: fixedClock{now: time.Date(2026, 7, 31, 20, 0, 0, 0, time.UTC)}, Heartbeat: func(context.Context) {}, Repository: &targetRepositoryProbe{}, GitHub: &targetGitHubProbe{}, Identity: targetTestIdentity, RepositoryCheckpoints: testRepositoryCheckpointFactory})
	if err != nil {
		t.Fatalf("NewRunWorkerActivities: %v", err)
	}
	in := targetAgentInput()
	in.PriorProviderThread = &ProviderThreadContinuation{Identity: targetTestIdentity, ThreadID: "thread-unavailable"}
	_, err = a.RunTargetAgent(context.Background(), in)
	if !errors.Is(err, ErrUnresumableIncompleteAttempt) || runner.calls != 0 {
		t.Fatalf("error/calls = %v / %d", err, runner.calls)
	}
}

func TestRunTargetAgentWaitsForThePostRotationCredentialRevision(t *testing.T) {
	t.Parallel()
	cp := &attemptCheckpointProbe{}
	runner := &targetStageRunnerProbe{}
	revision := &credentialRevisionProbe{revision: "1"}
	a, err := NewRunWorkerActivities(RunWorkerDeps{Stages: runner, Prompts: promptProbe{}, Checkpoints: func(store.TargetAttemptID) (AttemptCheckpoint, error) { return cp, nil }, CredentialRevision: revision.Observe, SecretRedactor: passthroughSecretRedactor{}, ProviderState: providerStateProbe{available: true}, Clock: fixedClock{now: time.Date(2026, 7, 31, 20, 0, 0, 0, time.UTC)}, Heartbeat: func(context.Context) {}, Repository: &targetRepositoryProbe{}, GitHub: &targetGitHubProbe{}, Identity: targetTestIdentity, RepositoryCheckpoints: testRepositoryCheckpointFactory})
	if err != nil {
		t.Fatalf("NewRunWorkerActivities: %v", err)
	}
	in := targetAgentInput()
	in.CredentialRevision.Revision = "2"
	if _, err := a.RunTargetAgent(context.Background(), in); err == nil || runner.calls != 0 || revision.calls != 1 {
		t.Fatalf("before projection catches up error/calls/observations = %v / %d / %d", err, runner.calls, revision.calls)
	}
	revision.revision = "2"
	if _, err := a.RunTargetAgent(context.Background(), in); err != nil {
		t.Fatalf("RunTargetAgent after projection update: %v", err)
	}
	if runner.calls != 1 || revision.calls != 2 {
		t.Fatalf("after projection update calls/observations = %d / %d", runner.calls, revision.calls)
	}
}

func TestRunTargetAgentRefusesCredentialRevisionFromAnotherGeneration(t *testing.T) {
	t.Parallel()
	runner := &targetStageRunnerProbe{}
	revision := &credentialRevisionProbe{revision: "1"}
	a, err := NewRunWorkerActivities(RunWorkerDeps{Stages: runner, Prompts: promptProbe{}, Checkpoints: func(store.TargetAttemptID) (AttemptCheckpoint, error) { return &attemptCheckpointProbe{}, nil }, CredentialRevision: revision.Observe, SecretRedactor: passthroughSecretRedactor{}, ProviderState: providerStateProbe{available: true}, Clock: fixedClock{now: time.Date(2026, 7, 31, 20, 0, 0, 0, time.UTC)}, Heartbeat: func(context.Context) {}, Repository: &targetRepositoryProbe{}, GitHub: &targetGitHubProbe{}, Identity: targetTestIdentity, RepositoryCheckpoints: testRepositoryCheckpointFactory})
	if err != nil {
		t.Fatalf("NewRunWorkerActivities: %v", err)
	}
	in := targetAgentInput()
	in.CredentialRevision.Identity.Generation++
	if _, err := a.RunTargetAgent(context.Background(), in); err == nil || runner.calls != 0 || revision.calls != 0 {
		t.Fatalf("wrong generation error/calls/observations = %v / %d / %d", err, runner.calls, revision.calls)
	}
}

func TestRunTargetAgentCheckpointsProviderAndTerminalBeforeSuccess(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 7, 31, 20, 0, 0, 0, time.UTC)
	cp := &attemptCheckpointProbe{}
	runner := &targetStageRunnerProbe{result: work.StageResult{Output: []byte(`{"document":"done"}`), ThreadID: "thread-live", Usage: work.Usage{InputTokens: 3, OutputTokens: 2}, UsageMeasured: true}}
	a, err := NewRunWorkerActivities(RunWorkerDeps{Stages: runner, Prompts: promptProbe{}, Checkpoints: func(store.TargetAttemptID) (AttemptCheckpoint, error) { return cp, nil }, CredentialRevision: observedCredentialRevision, SecretRedactor: passthroughSecretRedactor{}, ProviderState: providerStateProbe{available: true}, Clock: fixedClock{now: now}, Heartbeat: func(context.Context) {}, Repository: &targetRepositoryProbe{}, GitHub: &targetGitHubProbe{}, Identity: targetTestIdentity, RepositoryCheckpoints: testRepositoryCheckpointFactory})
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

func TestRunTargetAgentRedactsProjectedSecretsBeforeCheckpointOrOutput(t *testing.T) {
	t.Parallel()
	secrets := [][]byte{
		[]byte("github-token-for-test"),
		[]byte("codex-access-token-for-test"),
		[]byte("checkpoint-capability-for-test"),
		[]byte("repository-capability-for-test"),
	}
	cp := &attemptCheckpointProbe{}
	runner := &targetStageRunnerProbe{
		events: [][]byte{
			[]byte(`{"type":"thread.started","thread_id":"thread-live"}`),
			[]byte(`{"type":"item.completed","item":{"text":"github-token-for-test codex-access-token-for-test checkpoint-capability-for-test repository-capability-for-test"}}`),
		},
		result: work.StageResult{
			Output:   []byte(`{"report":"github-token-for-test","blocked":false,"blocked_reason":"","title":"checkpoint-capability-for-test","body":"repository-capability-for-test codex-access-token-for-test"}`),
			ThreadID: "thread-live", UsageMeasured: true,
		},
	}
	a, err := NewRunWorkerActivities(RunWorkerDeps{
		Stages: runner, Prompts: promptProbe{}, Checkpoints: func(store.TargetAttemptID) (AttemptCheckpoint, error) { return cp, nil },
		SecretRedactor: exactSecretRedactorProbe{values: secrets}, CredentialRevision: observedCredentialRevision,
		ProviderState: providerStateProbe{available: true}, Clock: fixedClock{now: time.Date(2026, 7, 31, 20, 0, 0, 0, time.UTC)},
		Heartbeat: func(context.Context) {}, Repository: &targetRepositoryProbe{}, GitHub: &targetGitHubProbe{}, Identity: targetTestIdentity,
		RepositoryCheckpoints: testRepositoryCheckpointFactory,
	})
	if err != nil {
		t.Fatalf("NewRunWorkerActivities: %v", err)
	}
	out, err := a.RunTargetAgent(context.Background(), targetAgentInput())
	if err != nil {
		t.Fatalf("RunTargetAgent: %v", err)
	}
	for _, secret := range secrets {
		if bytes.Contains(out.Output, secret) || bytes.Contains([]byte(out.Result.Prose()), secret) {
			t.Fatalf("activity output leaked %q: %+v", secret, out)
		}
		for _, write := range cp.writes {
			if bytes.Contains(write.Result, secret) {
				t.Fatalf("checkpoint result leaked %q: %s", secret, write.Result)
			}
			if write.Transcript != nil && bytes.Contains(decompressTranscript(t, write.Transcript.CompressedBytes), secret) {
				t.Fatalf("checkpoint transcript leaked %q", secret)
			}
		}
	}
}

func TestRunTargetAgentFailsPermanentlyWithoutLeakingSecretWhenRedactionInvalidatesResult(t *testing.T) {
	t.Parallel()
	secret := []byte("github-token-for-invalid-result-test")
	cp := &attemptCheckpointProbe{}
	runner := &targetStageRunnerProbe{result: work.StageResult{
		Output:   []byte(`{"report":"github-token-for-invalid-result-test","blocked":false,"blocked_reason":"","title":"Implement ticket","body":"Ready"}`),
		ThreadID: "thread-live", UsageMeasured: true,
	}}
	a, err := NewRunWorkerActivities(RunWorkerDeps{
		Stages: runner, Prompts: validatingPromptProbe{}, Checkpoints: func(store.TargetAttemptID) (AttemptCheckpoint, error) { return cp, nil },
		SecretRedactor: invalidatingSecretRedactor{exactSecretRedactorProbe{values: [][]byte{secret}}}, CredentialRevision: observedCredentialRevision,
		ProviderState: providerStateProbe{available: true}, Clock: fixedClock{now: time.Date(2026, 7, 31, 20, 0, 0, 0, time.UTC)},
		Heartbeat: func(context.Context) {}, Repository: &targetRepositoryProbe{}, GitHub: &targetGitHubProbe{}, Identity: targetTestIdentity,
		RepositoryCheckpoints: testRepositoryCheckpointFactory,
	})
	if err != nil {
		t.Fatalf("NewRunWorkerActivities: %v", err)
	}
	_, err = a.RunTargetAgent(context.Background(), targetAgentInput())
	var app *temporal.ApplicationError
	if !errors.As(err, &app) || app.Type() != ErrTypePermanent || !app.NonRetryable() || bytes.Contains([]byte(err.Error()), secret) {
		t.Fatalf("error = %v, want non-secret permanent result-redaction failure", err)
	}
	for _, write := range cp.writes {
		if bytes.Contains(write.Result, secret) || (write.Transcript != nil && bytes.Contains(decompressTranscript(t, write.Transcript.CompressedBytes), secret)) {
			t.Fatalf("checkpoint leaked %q: %+v", secret, write)
		}
	}
}

func TestRunTargetAgentDoesNotRetainRawProviderErrorInTemporalCause(t *testing.T) {
	t.Parallel()
	secret := []byte("github-token-for-error-chain-test")
	providerErr := fmt.Errorf("provider echoed %s: %w", secret, work.ErrPermanent)
	cp := &attemptCheckpointProbe{}
	runner := &targetStageRunnerProbe{err: providerErr}
	a, err := NewRunWorkerActivities(RunWorkerDeps{
		Stages: runner, Prompts: promptProbe{}, Checkpoints: func(store.TargetAttemptID) (AttemptCheckpoint, error) { return cp, nil },
		SecretRedactor: exactSecretRedactorProbe{values: [][]byte{secret}}, CredentialRevision: observedCredentialRevision,
		ProviderState: providerStateProbe{available: true}, Clock: fixedClock{now: time.Date(2026, 7, 31, 20, 0, 0, 0, time.UTC)},
		Heartbeat: func(context.Context) {}, Repository: &targetRepositoryProbe{}, GitHub: &targetGitHubProbe{}, Identity: targetTestIdentity,
		RepositoryCheckpoints: testRepositoryCheckpointFactory,
	})
	if err != nil {
		t.Fatalf("NewRunWorkerActivities: %v", err)
	}
	_, err = a.RunTargetAgent(context.Background(), targetAgentInput())
	var app *temporal.ApplicationError
	if !errors.As(err, &app) || app.Type() != ErrTypePermanent || !app.NonRetryable() {
		t.Fatalf("error = %v, want permanent application error", err)
	}

	var messages []string
	for current := err; current != nil; current = errors.Unwrap(current) {
		message := current.Error()
		if bytes.Contains([]byte(message), secret) {
			t.Fatalf("error chain leaked %q in %q", secret, message)
		}
		messages = append(messages, message)
	}
	serialized, marshalErr := json.Marshal(messages)
	if marshalErr != nil {
		t.Fatalf("serializing error chain: %v", marshalErr)
	}
	if bytes.Contains(serialized, secret) {
		t.Fatalf("serialized error chain leaked %q: %s", secret, serialized)
	}
}

func decompressTranscript(t *testing.T, compressed []byte) []byte {
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

type fixedClock struct{ now time.Time }

func (c fixedClock) Now() time.Time { return c.now }
