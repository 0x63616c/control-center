package activities

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	checkpointprotocol "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/checkpoint"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codex"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codexauth"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/github"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// ErrUnresumableIncompleteAttempt means durable provider identity exists but
// this worker generation cannot restore the provider's local state. Only the
// workflow may authorize another Attempt.
var ErrUnresumableIncompleteAttempt = fmt.Errorf("provider state is unavailable: %w", work.ErrPermanent)

// AttemptCheckpoint is one capability-scoped durable Attempt boundary.
type AttemptCheckpoint interface {
	Load(context.Context) (checkpointprotocol.Attempt, bool, error)
	Checkpoint(context.Context, checkpointprotocol.Attempt) error
}

// TargetStageRunner runs one authorized provider execution, optionally
// resuming the durable provider thread on the surviving worker generation.
type TargetStageRunner interface {
	RunTargetStage(context.Context, work.StageRun, string, work.StageEventSink) (work.StageResult, error)
}

// ProviderState proves whether a durable provider ID remains resumable on
// this worker's filesystem.
type ProviderState interface {
	Available(context.Context, string) (bool, error)
}

// SecretRedactor removes observed projected credential material from data that
// crosses the Run Worker durability boundary.
type SecretRedactor interface {
	Redact(context.Context, []byte) ([]byte, error)
}

// TargetRepository prepares the Run Worker's own filesystem checkout.
type TargetRepository interface {
	Prepare(context.Context, string, string) (string, error)
}

// TargetGitHub is the repository-scoped external surface hosted by the Run
// Worker. Its implementation reads the renewable projected token per request.
type TargetGitHub interface {
	PullRequestForBranch(context.Context, string) (work.PullRequest, bool, error)
	OpenOrUpdatePullRequest(context.Context, string, string, string, *work.PullRequest) (work.PullRequest, error)
	MarkPullRequestReadyForReview(context.Context, string) error
	MergePullRequest(context.Context, int, string) (work.PullRequestMergeResult, error)
	ChecksForCommit(context.Context, string, []string) ([]work.CheckRun, error)
}

// RepositoryCheckpoint is the distinct generation-scoped recovery boundary
// for repository-affine Steps. It is intentionally not an Agent Attempt
// checkpoint: its capability survives across many Steps on one generation.
type RepositoryCheckpoint interface {
	Load(context.Context) (store.GitCheckpoint, bool, error)
	Checkpoint(context.Context, store.GitCheckpointInput) (store.GitCheckpoint, error)
	CheckpointEffect(context.Context, store.GitCheckpointInput) (store.GitCheckpoint, error)
}

// RunWorkerDeps are the narrow dependencies of target agent execution.
type RunWorkerDeps struct {
	Stages                TargetStageRunner
	Prompts               PromptRenderer
	Checkpoints           func(store.TargetAttemptID) (AttemptCheckpoint, error)
	ProviderState         ProviderState
	CredentialRevision    func(context.Context) (string, error)
	SecretRedactor        SecretRedactor
	Clock                 interface{ Now() time.Time }
	Heartbeat             func(context.Context)
	Repository            TargetRepository
	GitHub                TargetGitHub
	Identity              work.RunWorkerIdentity
	RepositoryCheckpoints func(work.RunWorkerIdentity) (RepositoryCheckpoint, error)
}

// RunWorkerActivities are repository-affine target activities. They are kept
// separate from legacy Activities so missing target capabilities fail at the
// target composition root without widening the legacy sandbox.
type RunWorkerActivities struct{ deps RunWorkerDeps }

// NewRunWorkerActivities validates the target agent activity set once.
func NewRunWorkerActivities(deps RunWorkerDeps) (*RunWorkerActivities, error) {
	if deps.Stages == nil || deps.Prompts == nil || deps.Checkpoints == nil || deps.ProviderState == nil || deps.CredentialRevision == nil || deps.SecretRedactor == nil || deps.Clock == nil || deps.Heartbeat == nil || deps.Repository == nil || deps.GitHub == nil || deps.RepositoryCheckpoints == nil {
		return nil, fmt.Errorf("run worker activities require stages, prompts, checkpoints, provider state, credential revision, secret redactor, clock, heartbeat, repository, GitHub, and repository checkpoints")
	}
	if err := deps.Identity.Validate(); err != nil {
		return nil, fmt.Errorf("run worker activities require a valid identity: %w", err)
	}
	return &RunWorkerActivities{deps: deps}, nil
}

// TargetAgentInput names one workflow-authorized target Agent Attempt.
type TargetAgentInput struct {
	AttemptID    store.TargetAttemptID
	TicketNumber int
	Iteration    int
	Stage        work.AgentStage
	Model        work.Model
	Detail       work.TicketDetail
	Prior        work.PriorTurns
	// PromptContext carries the exact candidate and any authoritative feedback
	// into the real renderer; it is separate from agent-produced PriorTurns.
	PromptContext       work.AgentPromptContext
	PriorProviderThread *ProviderThreadContinuation
	CredentialRevision  CredentialRevisionExpectation
}

// ProviderThreadContinuation identifies an established implementer thread that
// may continue only on the Run Worker generation that owns its local state.
type ProviderThreadContinuation struct {
	Identity work.RunWorkerIdentity
	ThreadID string
}

// CredentialRevisionExpectation fences a target Agent Attempt to the
// credential revision installed for its exact Run Worker generation.
type CredentialRevisionExpectation struct {
	Identity work.RunWorkerIdentity
	Revision string
}

// TargetAgentOutput contains no credential or transcript; both durable forms
// cross the scoped checkpoint API before this result is acknowledged.
type TargetAgentOutput struct {
	Output     json.RawMessage
	Result     work.StageOutput
	ThreadID   string
	Usage      work.Usage
	UsageState work.UsageState
}

// RunTargetAgent reconciles durable evidence before any potentially billable
// provider call and checkpoints terminal evidence before success.
func (a *RunWorkerActivities) RunTargetAgent(ctx context.Context, in TargetAgentInput) (TargetAgentOutput, error) {
	cp, err := a.deps.Checkpoints(in.AttemptID)
	if err != nil {
		return TargetAgentOutput{}, fail(ctx, fmt.Sprintf("opening checkpoint for %s", in.AttemptID), err)
	}
	stored, found, err := cp.Load(ctx)
	if err != nil {
		return TargetAgentOutput{}, fail(ctx, fmt.Sprintf("loading checkpoint for %s", in.AttemptID), err)
	}
	resumeThread := ""
	if found {
		switch stored.State {
		case work.AgentAttemptSucceeded:
			result, redactErr := a.redactTargetResult(ctx, in.Stage, stored.Result)
			if redactErr != nil {
				return TargetAgentOutput{}, fail(ctx, fmt.Sprintf("redacting durable target result for %s", in.AttemptID), redactErr)
			}
			stored.Result = result
			return a.targetAgentOutput(in.Stage, stored)
		case work.AgentAttemptFailed:
			return TargetAgentOutput{}, fail(ctx, fmt.Sprintf("reconciling failed %s", in.AttemptID), ErrUnresumableIncompleteAttempt)
		case work.AgentAttemptRunning:
			available, stateErr := a.deps.ProviderState.Available(ctx, stored.ProviderThreadID)
			if stateErr != nil {
				return TargetAgentOutput{}, fail(ctx, fmt.Sprintf("checking provider state for %s", in.AttemptID), stateErr)
			}
			if !available {
				return TargetAgentOutput{}, fail(ctx, fmt.Sprintf("reconciling incomplete %s", in.AttemptID), ErrUnresumableIncompleteAttempt)
			}
			resumeThread = stored.ProviderThreadID
		default:
			return TargetAgentOutput{}, fail(ctx, fmt.Sprintf("reconciling %s", in.AttemptID), fmt.Errorf("unknown durable state %q: %w", stored.State, work.ErrPermanent))
		}
	} else if continuation := in.PriorProviderThread; continuation != nil {
		if in.Stage != work.AgentStageImplement || continuation.Identity != a.deps.Identity || continuation.ThreadID == "" {
			return TargetAgentOutput{}, fail(ctx, fmt.Sprintf("reconciling prior provider state for %s", in.AttemptID), ErrUnresumableIncompleteAttempt)
		}
		available, stateErr := a.deps.ProviderState.Available(ctx, continuation.ThreadID)
		if stateErr != nil {
			return TargetAgentOutput{}, fail(ctx, fmt.Sprintf("checking prior provider state for %s", in.AttemptID), stateErr)
		}
		if !available {
			return TargetAgentOutput{}, fail(ctx, fmt.Sprintf("reconciling unavailable prior provider state for %s", in.AttemptID), ErrUnresumableIncompleteAttempt)
		}
		resumeThread = continuation.ThreadID
	}
	if err := a.observeCredentialRevision(ctx, in.CredentialRevision); err != nil {
		return TargetAgentOutput{}, fail(ctx, fmt.Sprintf("observing projected credential revision for %s", in.AttemptID), err)
	}

	stage := work.Stage(in.Stage)
	key := work.StageKey{Ticket: in.TicketNumber, RunID: in.AttemptID.RunID, Stage: stage, Turn: in.Iteration}
	prompt, schema, err := a.deps.Prompts.Render(key, in.Detail, in.Prior, in.PromptContext)
	if err != nil {
		return TargetAgentOutput{}, fail(ctx, fmt.Sprintf("rendering target prompt for %s", in.AttemptID), err)
	}
	var transcript bytes.Buffer
	checkpointedThread := resumeThread != ""
	var checkpointErr error
	var redactionErr error
	events := func(raw []byte) {
		a.deps.Heartbeat(ctx)
		if redactionErr != nil {
			return
		}
		redacted, err := a.deps.SecretRedactor.Redact(ctx, raw)
		if err != nil {
			redactionErr = fmt.Errorf("reading projected secret material before checkpointing target events")
			return
		}
		transcript.Write(redacted)
		transcript.WriteByte('\n')
		if checkpointedThread || checkpointErr != nil {
			return
		}
		threadID := codex.ThreadIDFromEvent(raw)
		if threadID == "" {
			return
		}
		checkpointedThread = true
		checkpointErr = cp.Checkpoint(ctx, checkpointprotocol.Attempt{ProviderThreadID: threadID, State: work.AgentAttemptRunning, UsageState: work.UsageUnknown, Usage: checkpointprotocol.Usage{}, Transcript: checkpointTranscript(transcript.Bytes())})
	}
	result, runErr := a.deps.Stages.RunTargetStage(ctx, work.StageRun{Key: key, Sandbox: work.SandboxID("self"), Model: in.Model, Prompt: prompt, Schema: schema}, resumeThread, events)
	if redactionErr != nil {
		return TargetAgentOutput{}, fail(ctx, fmt.Sprintf("redacting target transcript for %s", in.AttemptID), redactionErr)
	}
	if checkpointErr != nil {
		return TargetAgentOutput{}, fail(ctx, fmt.Sprintf("checkpointing provider identity for %s", in.AttemptID), checkpointErr)
	}
	if runErr != nil {
		return TargetAgentOutput{}, fail(ctx, fmt.Sprintf("running target agent %s", in.AttemptID), a.redactError(ctx, runErr))
	}
	usageState := work.UsageUnknown
	if result.UsageMeasured {
		usageState = work.UsageMeasured
	}
	redactedResult, err := a.redactTargetResult(ctx, in.Stage, result.Output)
	if err != nil {
		return TargetAgentOutput{}, fail(ctx, fmt.Sprintf("redacting target result for %s", in.AttemptID), err)
	}
	endedAt := a.deps.Clock.Now().UTC()
	terminal := checkpointprotocol.Attempt{
		ProviderThreadID: result.ThreadID, State: work.AgentAttemptSucceeded, UsageState: usageState,
		Usage:   checkpointprotocol.Usage{InputTokens: result.Usage.InputTokens, CachedInputTokens: result.Usage.CachedInputTokens, OutputTokens: result.Usage.OutputTokens, ReasoningTokens: result.Usage.ReasoningTokens},
		EndedAt: &endedAt, Result: redactedResult, Transcript: checkpointTranscript(transcript.Bytes()),
	}
	if err := cp.Checkpoint(ctx, terminal); err != nil {
		return TargetAgentOutput{}, fail(ctx, fmt.Sprintf("checkpointing terminal evidence for %s", in.AttemptID), err)
	}
	return a.targetAgentOutput(in.Stage, terminal)
}

func (a *RunWorkerActivities) redactTargetResult(ctx context.Context, stage work.AgentStage, raw []byte) (json.RawMessage, error) {
	redacted, err := a.deps.SecretRedactor.Redact(ctx, raw)
	if err != nil {
		return nil, fmt.Errorf("reading projected secret material before checkpointing target result")
	}
	if _, err := a.deps.Prompts.Decode(work.Stage(stage), redacted); err != nil {
		return nil, fmt.Errorf("redacted target result is not a valid %s output: %w", stage, work.ErrPermanent)
	}
	return json.RawMessage(redacted), nil
}

type redactedError struct {
	message        string
	classification error
}

func (e redactedError) Error() string { return e.message }

// Unwrap retains only a safe retry/cancellation classification. In particular,
// it must never expose the raw provider error: Temporal serializes causes into
// workflow history and activity failure payloads.
func (e redactedError) Unwrap() error { return e.classification }

func (a *RunWorkerActivities) redactError(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	redacted, redactErr := a.deps.SecretRedactor.Redact(ctx, []byte(err.Error()))
	if redactErr != nil {
		return fmt.Errorf("reading projected secret material before reporting target agent failure")
	}
	return redactedError{message: string(redacted), classification: safeErrorClassification(err)}
}

func safeErrorClassification(err error) error {
	switch {
	case errors.Is(err, context.Canceled):
		return context.Canceled
	case errors.Is(err, context.DeadlineExceeded):
		return context.DeadlineExceeded
	case errors.Is(err, codex.ErrAuth):
		return codex.ErrAuth
	case errors.Is(err, codex.ErrRateLimited):
		return codex.ErrRateLimited
	case errors.Is(err, codexauth.ErrUnseeded):
		return codexauth.ErrUnseeded
	case errors.Is(err, github.ErrAuth):
		return github.ErrAuth
	case errors.Is(err, github.ErrRateLimit):
		return github.ErrRateLimit
	case errors.Is(err, github.ErrNotFound):
		return github.ErrNotFound
	case errors.Is(err, github.ErrInvalid):
		return github.ErrInvalid
	case errors.Is(err, github.ErrRuleset):
		return github.ErrRuleset
	case errors.Is(err, ErrUnresumableIncompleteAttempt):
		return ErrUnresumableIncompleteAttempt
	case errors.Is(err, work.ErrPermanent):
		return work.ErrPermanent
	default:
		return nil
	}
}

func (a *RunWorkerActivities) observeCredentialRevision(ctx context.Context, expected CredentialRevisionExpectation) error {
	if expected.Identity != a.deps.Identity || strings.TrimSpace(expected.Revision) == "" {
		return fmt.Errorf("credential revision expectation does not belong to this Run Worker generation: %w", work.ErrPermanent)
	}
	observed, err := a.deps.CredentialRevision(ctx)
	if err != nil {
		return fmt.Errorf("reading projected credential revision: %w", err)
	}
	if strings.TrimSpace(observed) != expected.Revision {
		return fmt.Errorf("projected credential revision %q has not reached expected revision %q", strings.TrimSpace(observed), expected.Revision)
	}
	return nil
}

func (a *RunWorkerActivities) targetAgentOutput(stage work.AgentStage, attempt checkpointprotocol.Attempt) (TargetAgentOutput, error) {
	decoded, err := a.deps.Prompts.Decode(work.Stage(stage), attempt.Result)
	if err != nil {
		return TargetAgentOutput{}, fmt.Errorf("decoding durable target result: %w", err)
	}
	return TargetAgentOutput{Output: attempt.Result, Result: decoded, ThreadID: attempt.ProviderThreadID, Usage: work.Usage{InputTokens: attempt.Usage.InputTokens, CachedInputTokens: attempt.Usage.CachedInputTokens, OutputTokens: attempt.Usage.OutputTokens, ReasoningTokens: attempt.Usage.ReasoningTokens}, UsageState: attempt.UsageState}, nil
}

func checkpointTranscript(raw []byte) *checkpointprotocol.Transcript {
	if len(raw) == 0 {
		return nil
	}
	var compressed bytes.Buffer
	gz := gzip.NewWriter(&compressed)
	_, _ = gz.Write(raw)
	_ = gz.Close()
	checksum := sha256.Sum256(raw)
	return &checkpointprotocol.Transcript{CompressedBytes: compressed.Bytes(), Compression: "gzip", UncompressedSizeBytes: int64(len(raw)), Checksum: checksum[:]}
}
