// Package storetest holds reusable behavioral contracts for Store implementations.
package storetest

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// TargetStore is the shared target persistence behavior exercised by the
// PostgreSQL Store and its in-memory fake.
type TargetStore interface {
	store.TicketCreator
	store.TargetRunClaimer
	store.TargetStepRecorder
	store.TargetAgentRecorder
	store.TargetTerminalRecorder
	BindCheckpointCapability(context.Context, store.TargetAttemptID, string) error
	CheckpointGitEffect(context.Context, store.GitCheckpointInput) (store.GitCheckpoint, error)
}

// RunTargetConflictContract verifies that a Store accepts exact retries and
// rejects conflicting terminal evidence in the same way as the real Store.
func RunTargetConflictContract(t *testing.T, newStore func(*testing.T) TargetStore) {
	t.Helper()
	t.Run("agent checkpoint", func(t *testing.T) {
		s, _, runID, startedAt := claimedRun(t, newStore(t))
		ctx := context.Background()
		if _, err := s.StartStep(ctx, store.StartStepInput{RunID: runID, Ordinal: 1, Kind: work.StepImplement, StartedAt: startedAt}); err != nil {
			t.Fatalf("StartStep: %v", err)
		}
		attemptID := store.TargetAttemptID{RunID: runID, StepOrdinal: 1, AttemptNo: 1}
		if _, err := s.StartAgentAttempt(ctx, store.StartAgentAttemptInput{ID: attemptID, AgentStage: work.AgentStageImplement, Model: work.Model{Name: "contract-model", Effort: "medium"}, UsageState: work.UsageUnknown, StartedAt: startedAt}); err != nil {
			t.Fatalf("StartAgentAttempt: %v", err)
		}
		if err := s.BindCheckpointCapability(ctx, attemptID, "contract-capability"); err != nil {
			t.Fatalf("BindCheckpointCapability: %v", err)
		}
		checkpoint := store.AgentCheckpointInput{
			ID: attemptID, Capability: "contract-capability", ThreadID: "thread-1",
			State: work.AgentAttemptSucceeded, UsageState: work.UsageMeasured,
			Usage:   work.Usage{InputTokens: 3, CachedInputTokens: 1, OutputTokens: 2, ReasoningTokens: 1},
			EndedAt: startedAt.Add(time.Minute), Result: []byte(`{"kind":"done"}`),
			Transcript: &store.TargetTranscript{CompressedBytes: []byte("transcript"), Compression: "zstd", UncompressedSizeBytes: 10, Checksum: []byte("checksum")},
		}
		if _, err := s.CheckpointAgentAttempt(ctx, checkpoint); err != nil {
			t.Fatalf("CheckpointAgentAttempt: %v", err)
		}
		if _, err := s.CheckpointAgentAttempt(ctx, checkpoint); err != nil {
			t.Fatalf("CheckpointAgentAttempt(exact retry): %v", err)
		}
		checkpoint.Result = []byte(`{"kind":"different"}`)
		if _, err := s.CheckpointAgentAttempt(ctx, checkpoint); !errors.Is(err, work.ErrPermanent) {
			t.Fatalf("CheckpointAgentAttempt(conflict) error = %v, want permanent", err)
		}
		checkpoint.Result = []byte(`{"kind":"done"}`)
		checkpoint.Transcript.Checksum = []byte("different-checksum")
		if _, err := s.CheckpointAgentAttempt(ctx, checkpoint); !errors.Is(err, work.ErrPermanent) {
			t.Fatalf("CheckpointAgentAttempt(transcript conflict) error = %v, want permanent", err)
		}
	})

	t.Run("git checkpoint pull request", func(t *testing.T) {
		s, _, runID, startedAt := claimedRun(t, newStore(t))
		ctx := context.Background()
		if _, err := s.StartStep(ctx, store.StartStepInput{RunID: runID, Ordinal: 1, Kind: work.StepSyncPullRequest, StartedAt: startedAt}); err != nil {
			t.Fatalf("StartStep: %v", err)
		}
		checkpoint := store.GitCheckpointInput{GitCheckpoint: store.GitCheckpoint{RunID: runID, StepOrdinal: 1, Branch: "factory/contract", PushedHead: "head-1", ObservedBase: "base-1", PullRequestNumber: 7, PullRequestNodeID: "node-7", StepResult: []byte(`{"kind":"synced"}`)}, CompletedAt: startedAt.Add(time.Minute)}
		if _, err := s.CheckpointGitEffect(ctx, checkpoint); err != nil {
			t.Fatalf("CheckpointGitEffect: %v", err)
		}
		if _, err := s.CheckpointGitEffect(ctx, checkpoint); err != nil {
			t.Fatalf("CheckpointGitEffect(exact retry): %v", err)
		}
		checkpoint.PullRequestNumber = 8
		if _, err := s.CheckpointGitEffect(ctx, checkpoint); !errors.Is(err, work.ErrPermanent) {
			t.Fatalf("CheckpointGitEffect(conflict) error = %v, want permanent", err)
		}
	})

	t.Run("confirmed merge", func(t *testing.T) {
		s, ticket, runID, startedAt := claimedRun(t, newStore(t))
		ctx := context.Background()
		if _, err := s.StartStep(ctx, store.StartStepInput{RunID: runID, Ordinal: 1, Kind: work.StepMergePullRequest, StartedAt: startedAt}); err != nil {
			t.Fatalf("StartStep: %v", err)
		}
		terminal := store.ConfirmedMergeInput{RunID: runID, TicketID: ticket.ID, StepOrdinal: 1, ReviewedHead: "head-1", MergeSHA: "merge-1", EndedAt: startedAt.Add(time.Minute)}
		if _, err := s.FinalizeConfirmedMerge(ctx, terminal); err != nil {
			t.Fatalf("FinalizeConfirmedMerge: %v", err)
		}
		if _, err := s.FinalizeConfirmedMerge(ctx, terminal); err != nil {
			t.Fatalf("FinalizeConfirmedMerge(exact retry): %v", err)
		}
		terminal.MergeSHA = "merge-2"
		if _, err := s.FinalizeConfirmedMerge(ctx, terminal); !errors.Is(err, work.ErrPermanent) {
			t.Fatalf("FinalizeConfirmedMerge(conflict) error = %v, want permanent", err)
		}
	})
}

func claimedRun(t *testing.T, s TargetStore) (TargetStore, store.Ticket, string, time.Time) {
	t.Helper()
	ctx := context.Background()
	ticket, err := s.CreateTicket(ctx, "target contract", "", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	runID := uuid.NewString()
	startedAt := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	if _, err := s.ClaimAndStartRun(ctx, store.ClaimRunInput{TicketID: ticket.ID, RunID: runID, StartedAt: startedAt}); err != nil {
		t.Fatalf("ClaimAndStartRun: %v", err)
	}
	return s, ticket, runID, startedAt
}
