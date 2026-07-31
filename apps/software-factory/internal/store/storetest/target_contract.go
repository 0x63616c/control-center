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
	store.TicketStateWriter
	store.TargetRunClaimer
	store.TargetStepRecorder
	store.TargetAgentRecorder
	store.TargetTerminalRecorder
	TargetRunDetail(context.Context, string) (store.TargetRunDetail, error)
	BindCheckpointCapability(context.Context, store.TargetAttemptID, string) error
	CheckpointGitEffect(context.Context, store.GitCheckpointInput) (store.GitCheckpoint, error)
}

// RunTargetConflictContract verifies that a Store accepts exact retries and
// rejects conflicting terminal evidence in the same way as the real Store.
func RunTargetConflictContract(t *testing.T, newStore func(*testing.T) TargetStore) {
	t.Helper()
	t.Run("generic ticket state cannot create target ownership", func(t *testing.T) {
		s := newStore(t)
		ctx := context.Background()
		ticket, err := s.CreateTicket(ctx, "target ownership", "", nil)
		if err != nil {
			t.Fatalf("CreateTicket: %v", err)
		}
		if _, err := s.UpdateTicketState(ctx, ticket.ID, store.TicketActive); !errors.Is(err, store.ErrActiveTicketOwnership) {
			t.Fatalf("UpdateTicketState(active) error = %v, want ErrActiveTicketOwnership", err)
		}
		if _, err := s.TransitionTicketState(ctx, ticket.ID, store.TicketOpen, store.TicketActive); !errors.Is(err, store.ErrActiveTicketOwnership) {
			t.Fatalf("TransitionTicketState(active) error = %v, want ErrActiveTicketOwnership", err)
		}
		if _, err := s.TransitionTicketState(ctx, ticket.ID, store.TicketOpen, store.TicketWorking); err != nil {
			t.Fatalf("TransitionTicketState(working): %v", err)
		}
		if _, err := s.TransitionTicketState(ctx, ticket.ID, store.TicketWorking, store.TicketReview); err != nil {
			t.Fatalf("TransitionTicketState(review): %v", err)
		}
	})

	t.Run("agent attempt requires its agent step", func(t *testing.T) {
		s, _, runID, startedAt := claimedRun(t, newStore(t))
		ctx := context.Background()
		for _, test := range []struct {
			name  string
			kind  work.StepKind
			stage work.AgentStage
		}{
			{name: "clone repository", kind: work.StepCloneRepository, stage: work.AgentStageImplement},
			{name: "mismatched agent stage", kind: work.StepPlan, stage: work.AgentStageImplement},
		} {
			t.Run(test.name, func(t *testing.T) {
				ordinal := 1
				if test.name == "mismatched agent stage" {
					ordinal = 2
				}
				if _, err := s.StartStep(ctx, store.StartStepInput{RunID: runID, Ordinal: ordinal, Kind: test.kind, StartedAt: startedAt}); err != nil {
					t.Fatalf("StartStep: %v", err)
				}
				_, err := s.StartAgentAttempt(ctx, store.StartAgentAttemptInput{
					ID:         store.TargetAttemptID{RunID: runID, StepOrdinal: ordinal, AttemptNo: 1},
					AgentStage: test.stage,
					Model:      work.Model{Name: "contract-model", Effort: "medium"},
					UsageState: work.UsageUnknown,
					StartedAt:  startedAt,
				})
				if !errors.Is(err, store.ErrAgentAttemptStep) {
					t.Fatalf("StartAgentAttempt error = %v, want ErrAgentAttemptStep", err)
				}
			})
		}
	})

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

	t.Run("canceled owner cannot checkpoint an agent attempt", func(t *testing.T) {
		s, ticket, runID, startedAt := claimedRun(t, newStore(t))
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
		if _, err := s.CancelRun(ctx, store.CancelRunInput{RunID: runID, TicketID: ticket.ID, EndedAt: startedAt.Add(time.Minute)}); err != nil {
			t.Fatalf("CancelRun: %v", err)
		}
		_, err := s.CheckpointAgentAttempt(ctx, store.AgentCheckpointInput{ID: attemptID, Capability: "contract-capability", ThreadID: "thread-1", State: work.AgentAttemptSucceeded, UsageState: work.UsageMeasured, EndedAt: startedAt.Add(2 * time.Minute), Result: []byte(`{"kind":"done"}`), Transcript: &store.TargetTranscript{CompressedBytes: []byte("transcript"), Compression: "zstd", UncompressedSizeBytes: 10, Checksum: []byte("checksum")}})
		if !errors.Is(err, store.ErrRunOwnership) {
			t.Fatalf("CheckpointAgentAttempt after cancellation error = %v, want ErrRunOwnership", err)
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

	t.Run("confirmed merge fences successor owner", func(t *testing.T) {
		s, ticket, firstRunID, startedAt := claimedRun(t, newStore(t))
		ctx := context.Background()
		if _, err := s.StartStep(ctx, store.StartStepInput{RunID: firstRunID, Ordinal: 1, Kind: work.StepMergePullRequest, StartedAt: startedAt}); err != nil {
			t.Fatalf("StartStep(first merge): %v", err)
		}
		if _, err := s.CancelRun(ctx, store.CancelRunInput{RunID: firstRunID, TicketID: ticket.ID, EndedAt: startedAt.Add(time.Minute)}); err != nil {
			t.Fatalf("CancelRun(first): %v", err)
		}
		secondRunID := uuid.NewString()
		if _, err := s.ClaimAndStartRun(ctx, store.ClaimRunInput{TicketID: ticket.ID, RunID: secondRunID, StartedAt: startedAt.Add(2 * time.Minute)}); err != nil {
			t.Fatalf("ClaimAndStartRun(second): %v", err)
		}
		result, err := s.FinalizeConfirmedMerge(ctx, store.ConfirmedMergeInput{RunID: firstRunID, TicketID: ticket.ID, StepOrdinal: 1, ReviewedHead: "first-head", MergeSHA: "first-merge", EndedAt: startedAt.Add(3 * time.Minute)})
		if err != nil {
			t.Fatalf("FinalizeConfirmedMerge(first): %v", err)
		}
		second, err := s.TargetRunDetail(ctx, secondRunID)
		if err != nil {
			t.Fatalf("TargetRunDetail(second): %v", err)
		}
		if result.Ticket.State != store.TicketDone || result.Ticket.ActiveRunID != "" || second.Run.TargetOutcome != work.RunOutcomeCanceled {
			t.Fatalf("successor fence = result %+v, second %+v; want done Ticket and canceled successor", result, second.Run)
		}
	})

	t.Run("confirmed merge requires merge step", func(t *testing.T) {
		s, ticket, runID, startedAt := claimedRun(t, newStore(t))
		ctx := context.Background()
		terminal := store.ConfirmedMergeInput{RunID: runID, TicketID: ticket.ID, StepOrdinal: 1, ReviewedHead: "head-1", MergeSHA: "merge-1", EndedAt: startedAt.Add(time.Minute)}
		if _, err := s.FinalizeConfirmedMerge(ctx, terminal); !errors.Is(err, store.ErrMergeStep) {
			t.Fatalf("FinalizeConfirmedMerge without step error = %v, want ErrMergeStep", err)
		}
		if _, err := s.StartStep(ctx, store.StartStepInput{RunID: runID, Ordinal: 1, Kind: work.StepAwaitCI, StartedAt: startedAt}); err != nil {
			t.Fatalf("StartStep: %v", err)
		}
		if _, err := s.FinalizeConfirmedMerge(ctx, terminal); !errors.Is(err, store.ErrMergeStep) {
			t.Fatalf("FinalizeConfirmedMerge with non-merge step error = %v, want ErrMergeStep", err)
		}
		if _, err := s.StartStep(ctx, store.StartStepInput{RunID: runID, Ordinal: 2, Kind: work.StepMergePullRequest, StartedAt: startedAt}); err != nil {
			t.Fatalf("StartStep(merge): %v", err)
		}
		terminal.StepOrdinal = 2
		if _, err := s.FinalizeConfirmedMerge(ctx, terminal); err != nil {
			t.Fatalf("FinalizeConfirmedMerge: %v", err)
		}
		detail, err := s.TargetRunDetail(ctx, runID)
		if err != nil {
			t.Fatalf("TargetRunDetail: %v", err)
		}
		if len(detail.Steps) != 2 || detail.Steps[1].Step.State != work.StepStateCompleted {
			t.Fatalf("Merge Step = %+v, want completed", detail.Steps)
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
