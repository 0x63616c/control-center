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
	store.TicketReader
	store.TicketStateWriter
	store.WebhookDeliveryRecorder
	store.TargetRunClaimer
	store.TargetStepRecorder
	store.TargetAgentRecorder
	store.TargetTerminalRecorder
	TargetRunDetail(context.Context, string) (store.TargetRunDetail, error)
	BindCheckpointCapability(context.Context, store.TargetAttemptID, string) error
	CheckpointGitEffect(context.Context, store.GitCheckpointInput) (store.GitCheckpoint, error)
	ReconcileAbandonedRun(context.Context, string, store.TicketID) (bool, error)
}

// RunTargetConflictContract verifies that a Store accepts exact retries and
// rejects conflicting terminal evidence in the same way as the real Store.
func RunTargetConflictContract(t *testing.T, newStore func(*testing.T) TargetStore) {
	t.Helper()
	t.Run("done tickets are terminal across every public writer", func(t *testing.T) {
		s := newStore(t)
		ctx := context.Background()
		done, err := s.CreateTicket(ctx, "terminal ticket", "", nil)
		if err != nil {
			t.Fatalf("CreateTicket(done): %v", err)
		}
		if _, err := s.UpdateTicketState(ctx, done.ID, store.TicketDone); err != nil {
			t.Fatalf("UpdateTicketState(done): %v", err)
		}
		if _, err := s.UpdateTicketState(ctx, done.ID, store.TicketOpen); err == nil {
			t.Fatal("UpdateTicketState(done -> open) succeeded, want terminal-state rejection")
		}
		if _, err := s.TransitionTicketState(ctx, done.ID, store.TicketDone, store.TicketFailed); err == nil {
			t.Fatal("TransitionTicketState(done -> failed) succeeded, want terminal-state rejection")
		}
		outcome, err := s.RecordWebhookDeliveryAndTransition(ctx, "terminal-delivery-"+uuid.NewString(), done.ID, store.TicketDone, store.TicketFailed)
		if err != nil {
			t.Fatalf("RecordWebhookDeliveryAndTransition(done -> failed): %v", err)
		}
		if outcome != store.WebhookDeliveryStale {
			t.Fatalf("webhook outcome = %v, want stale", outcome)
		}
		outcome, err = s.RecordWebhookDeliveryAndTransition(ctx, "terminal-retry-delivery-"+uuid.NewString(), done.ID, store.TicketDone, store.TicketDone)
		if err != nil {
			t.Fatalf("RecordWebhookDeliveryAndTransition(done -> done): %v", err)
		}
		if outcome != store.WebhookDeliveryApplied {
			t.Fatalf("webhook done -> done outcome = %v, want applied idempotent transition", outcome)
		}
		stored, err := s.Ticket(ctx, done.ID)
		if err != nil {
			t.Fatalf("Ticket(done): %v", err)
		}
		if stored.State != store.TicketDone {
			t.Fatalf("Ticket state = %s, want done", stored.State)
		}

		failed, err := s.CreateTicket(ctx, "retryable failure", "", nil)
		if err != nil {
			t.Fatalf("CreateTicket(failed): %v", err)
		}
		if _, err := s.UpdateTicketState(ctx, failed.ID, store.TicketFailed); err != nil {
			t.Fatalf("UpdateTicketState(failed): %v", err)
		}
		if _, err := s.TransitionTicketState(ctx, failed.ID, store.TicketFailed, store.TicketOpen); err != nil {
			t.Fatalf("TransitionTicketState(failed -> open): %v", err)
		}
	})

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
		outcome, err := s.RecordWebhookDeliveryAndTransition(ctx, "active-target-delivery-"+uuid.NewString(), ticket.ID, store.TicketOpen, store.TicketActive)
		if err != nil {
			t.Fatalf("RecordWebhookDeliveryAndTransition(open -> active): %v", err)
		}
		if outcome != store.WebhookDeliveryStale {
			t.Fatalf("webhook open -> active outcome = %v, want stale", outcome)
		}
		if _, err := s.TransitionTicketState(ctx, ticket.ID, store.TicketOpen, store.TicketWorking); err != nil {
			t.Fatalf("TransitionTicketState(working): %v", err)
		}
		if _, err := s.TransitionTicketState(ctx, ticket.ID, store.TicketWorking, store.TicketReview); err != nil {
			t.Fatalf("TransitionTicketState(review): %v", err)
		}
	})

	t.Run("generic ticket state cannot release target ownership", func(t *testing.T) {
		s, ticket, runID, _ := claimedRun(t, newStore(t))
		ctx := context.Background()
		if _, err := s.UpdateTicketState(ctx, ticket.ID, store.TicketOpen); !errors.Is(err, store.ErrActiveTicketOwnership) {
			t.Fatalf("UpdateTicketState(active -> open) error = %v, want ErrActiveTicketOwnership", err)
		}
		if _, err := s.TransitionTicketState(ctx, ticket.ID, store.TicketActive, store.TicketFailed); !errors.Is(err, store.ErrActiveTicketOwnership) {
			t.Fatalf("TransitionTicketState(active -> failed) error = %v, want ErrActiveTicketOwnership", err)
		}
		outcome, err := s.RecordWebhookDeliveryAndTransition(ctx, "active-owner-delivery-"+uuid.NewString(), ticket.ID, store.TicketActive, store.TicketFailed)
		if err != nil {
			t.Fatalf("RecordWebhookDeliveryAndTransition(active -> failed): %v", err)
		}
		if outcome != store.WebhookDeliveryStale {
			t.Fatalf("webhook active -> failed outcome = %v, want stale", outcome)
		}
		stored, err := s.Ticket(ctx, ticket.ID)
		if err != nil {
			t.Fatalf("Ticket(active): %v", err)
		}
		if stored.State != store.TicketActive || stored.ActiveRunID != runID {
			t.Fatalf("Ticket = %+v, want active owner %s", stored, runID)
		}
	})

	t.Run("run identity belongs to exactly one ticket", func(t *testing.T) {
		s := newStore(t)
		ctx := context.Background()
		first, err := s.CreateTicket(ctx, "first target owner", "", nil)
		if err != nil {
			t.Fatalf("CreateTicket(first): %v", err)
		}
		second, err := s.CreateTicket(ctx, "second target owner", "", nil)
		if err != nil {
			t.Fatalf("CreateTicket(second): %v", err)
		}
		runID := uuid.NewString()
		startedAt := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
		claim := store.ClaimRunInput{TicketID: first.ID, RunID: runID, StartedAt: startedAt}
		if _, err := s.ClaimAndStartRun(ctx, claim); err != nil {
			t.Fatalf("ClaimAndStartRun(first): %v", err)
		}
		if _, err := s.ClaimAndStartRun(ctx, claim); err != nil {
			t.Fatalf("ClaimAndStartRun(exact retry): %v", err)
		}
		if _, err := s.ClaimAndStartRun(ctx, store.ClaimRunInput{TicketID: second.ID, RunID: runID, StartedAt: startedAt}); !errors.Is(err, work.ErrPermanent) {
			t.Fatalf("ClaimAndStartRun(reused run identity) error = %v, want permanent", err)
		}
		stored, err := s.Ticket(ctx, second.ID)
		if err != nil {
			t.Fatalf("Ticket(second): %v", err)
		}
		if stored.State != store.TicketOpen || stored.ActiveRunID != "" {
			t.Fatalf("second Ticket = %+v, want unchanged open Ticket", stored)
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

	t.Run("agent attempt rejects a completed parent step", func(t *testing.T) {
		s, _, runID, startedAt := claimedRun(t, newStore(t))
		ctx := context.Background()
		if _, err := s.StartStep(ctx, store.StartStepInput{RunID: runID, Ordinal: 1, Kind: work.StepPlan, StartedAt: startedAt}); err != nil {
			t.Fatalf("StartStep: %v", err)
		}
		if _, err := s.CompleteStep(ctx, runID, 1, startedAt.Add(time.Minute), []byte(`{"kind":"planned"}`)); err != nil {
			t.Fatalf("CompleteStep: %v", err)
		}
		_, err := s.StartAgentAttempt(ctx, store.StartAgentAttemptInput{
			ID:         store.TargetAttemptID{RunID: runID, StepOrdinal: 1, AttemptNo: 1},
			AgentStage: work.AgentStagePlan,
			Model:      work.Model{Name: "contract-model", Effort: "medium"},
			UsageState: work.UsageUnknown,
			StartedAt:  startedAt.Add(2 * time.Minute),
		})
		if !errors.Is(err, store.ErrAgentAttemptStep) {
			t.Fatalf("StartAgentAttempt under completed Step error = %v, want ErrAgentAttemptStep", err)
		}

		if _, err := s.StartStep(ctx, store.StartStepInput{RunID: runID, Ordinal: 2, Kind: work.StepPlan, StartedAt: startedAt}); err != nil {
			t.Fatalf("StartStep(retry parent): %v", err)
		}
		retryInput := store.StartAgentAttemptInput{
			ID:         store.TargetAttemptID{RunID: runID, StepOrdinal: 2, AttemptNo: 1},
			AgentStage: work.AgentStagePlan,
			Model:      work.Model{Name: "contract-model", Effort: "medium"},
			UsageState: work.UsageUnknown,
			StartedAt:  startedAt,
		}
		if _, err := s.StartAgentAttempt(ctx, retryInput); err != nil {
			t.Fatalf("StartAgentAttempt(running parent): %v", err)
		}
		if _, err := s.CompleteStep(ctx, runID, 2, startedAt.Add(time.Minute), []byte(`{"kind":"planned"}`)); err != nil {
			t.Fatalf("CompleteStep(retry parent): %v", err)
		}
		if _, err := s.StartAgentAttempt(ctx, retryInput); !errors.Is(err, work.ErrPermanent) {
			t.Fatalf("StartAgentAttempt retry under completed Step error = %v, want permanent rejection", err)
		}
	})

	t.Run("step and attempt retries are exact and completion time is immutable", func(t *testing.T) {
		s, _, runID, startedAt := claimedRun(t, newStore(t))
		ctx := context.Background()
		stepInput := store.StartStepInput{RunID: runID, Ordinal: 1, Kind: work.StepImplement, Iteration: 1, Reason: "first implementation", StartedAt: startedAt}
		if _, err := s.StartStep(ctx, stepInput); err != nil {
			t.Fatalf("StartStep: %v", err)
		}
		if _, err := s.StartStep(ctx, stepInput); err != nil {
			t.Fatalf("StartStep(exact retry): %v", err)
		}
		for _, conflict := range []store.StartStepInput{
			{RunID: runID, Ordinal: 1, Kind: work.StepReview, Iteration: 1, Reason: "first implementation", StartedAt: startedAt},
			{RunID: runID, Ordinal: 1, Kind: work.StepImplement, Iteration: 2, Reason: "first implementation", StartedAt: startedAt},
			{RunID: runID, Ordinal: 1, Kind: work.StepImplement, Iteration: 1, Reason: "different reason", StartedAt: startedAt},
			{RunID: runID, Ordinal: 1, Kind: work.StepImplement, Iteration: 1, Reason: "first implementation", StartedAt: startedAt.Add(time.Second)},
		} {
			if _, err := s.StartStep(ctx, conflict); !errors.Is(err, work.ErrPermanent) {
				t.Fatalf("StartStep(conflict %+v) error = %v, want permanent", conflict, err)
			}
		}

		attemptInput := store.StartAgentAttemptInput{ID: store.TargetAttemptID{RunID: runID, StepOrdinal: 1, AttemptNo: 1}, AgentStage: work.AgentStageImplement, Model: work.Model{Name: "contract-model", Effort: "medium"}, UsageState: work.UsageUnknown, StartedAt: startedAt}
		if _, err := s.StartAgentAttempt(ctx, attemptInput); err != nil {
			t.Fatalf("StartAgentAttempt: %v", err)
		}
		if _, err := s.StartAgentAttempt(ctx, attemptInput); err != nil {
			t.Fatalf("StartAgentAttempt(exact retry): %v", err)
		}
		for _, conflict := range []store.StartAgentAttemptInput{
			{ID: attemptInput.ID, AgentStage: work.AgentStageReview, Model: attemptInput.Model, UsageState: attemptInput.UsageState, StartedAt: attemptInput.StartedAt},
			{ID: attemptInput.ID, AgentStage: attemptInput.AgentStage, Model: work.Model{Name: "other-model", Effort: "medium"}, UsageState: attemptInput.UsageState, StartedAt: attemptInput.StartedAt},
			{ID: attemptInput.ID, AgentStage: attemptInput.AgentStage, Model: work.Model{Name: "contract-model", Effort: "high"}, UsageState: attemptInput.UsageState, StartedAt: attemptInput.StartedAt},
			{ID: attemptInput.ID, AgentStage: attemptInput.AgentStage, Model: attemptInput.Model, UsageState: work.UsageMeasured, StartedAt: attemptInput.StartedAt},
			{ID: attemptInput.ID, AgentStage: attemptInput.AgentStage, Model: attemptInput.Model, UsageState: attemptInput.UsageState, StartedAt: attemptInput.StartedAt.Add(time.Second)},
		} {
			if _, err := s.StartAgentAttempt(ctx, conflict); !errors.Is(err, work.ErrPermanent) {
				t.Fatalf("StartAgentAttempt(conflict %+v) error = %v, want permanent", conflict, err)
			}
		}

		firstEndedAt := startedAt.Add(time.Minute)
		result := []byte(`{"kind":"implemented"}`)
		if _, err := s.CompleteStep(ctx, runID, 1, firstEndedAt, result); err != nil {
			t.Fatalf("CompleteStep: %v", err)
		}
		retry, err := s.CompleteStep(ctx, runID, 1, firstEndedAt.Add(time.Minute), result)
		if err != nil {
			t.Fatalf("CompleteStep(exact retry): %v", err)
		}
		if !retry.EndedAt.Equal(firstEndedAt) {
			t.Fatalf("CompleteStep retry ended_at = %s, want original %s", retry.EndedAt, firstEndedAt)
		}
		if _, err := s.CompleteStep(ctx, runID, 1, firstEndedAt.Add(2*time.Minute), []byte(`{"kind":"different"}`)); !errors.Is(err, work.ErrPermanent) {
			t.Fatalf("CompleteStep(conflict) error = %v, want permanent", err)
		}
	})

	t.Run("agent checkpoint persists running progress before terminal evidence", func(t *testing.T) {
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
		running := store.AgentCheckpointInput{
			ID: attemptID, Capability: "contract-capability", ThreadID: "thread-1",
			State: work.AgentAttemptRunning, UsageState: work.UsageMeasured,
			Usage:      work.Usage{InputTokens: 3, CachedInputTokens: 1, OutputTokens: 2, ReasoningTokens: 1},
			Transcript: &store.TargetTranscript{CompressedBytes: []byte("partial transcript"), Compression: "zstd", UncompressedSizeBytes: 18, Checksum: []byte("partial-checksum")},
		}
		if _, err := s.CheckpointAgentAttempt(ctx, running); err != nil {
			t.Fatalf("CheckpointAgentAttempt(running): %v", err)
		}
		if _, err := s.CheckpointAgentAttempt(ctx, running); err != nil {
			t.Fatalf("CheckpointAgentAttempt(running exact retry): %v", err)
		}
		detail, err := s.TargetRunDetail(ctx, runID)
		if err != nil {
			t.Fatalf("TargetRunDetail(running checkpoint): %v", err)
		}
		if len(detail.Steps) != 1 || len(detail.Steps[0].Attempts) != 1 {
			t.Fatalf("TargetRunDetail(running checkpoint) = %+v, want one Attempt", detail)
		}
		persisted := detail.Steps[0].Attempts[0]
		if persisted.State != work.AgentAttemptRunning || !persisted.EndedAt.IsZero() || persisted.ProviderThreadID != running.ThreadID || persisted.Usage != running.Usage || !persisted.TranscriptPresent {
			t.Fatalf("running checkpoint = %+v, want durable non-terminal progress", persisted)
		}
		running.ThreadID = "different-thread"
		if _, err := s.CheckpointAgentAttempt(ctx, running); !errors.Is(err, work.ErrPermanent) {
			t.Fatalf("CheckpointAgentAttempt(running conflict) error = %v, want permanent", err)
		}

		checkpoint := store.AgentCheckpointInput{
			ID: attemptID, Capability: "contract-capability", ThreadID: "thread-1",
			State: work.AgentAttemptSucceeded, UsageState: work.UsageMeasured,
			Usage:   work.Usage{InputTokens: 3, CachedInputTokens: 1, OutputTokens: 2, ReasoningTokens: 1},
			EndedAt: startedAt.Add(time.Minute), Result: []byte(`{"kind":"done"}`),
			Transcript: &store.TargetTranscript{CompressedBytes: []byte("terminal transcript"), Compression: "zstd", UncompressedSizeBytes: 19, Checksum: []byte("terminal-checksum")},
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
		firstCompletedAt := checkpoint.CompletedAt
		checkpoint.CompletedAt = checkpoint.CompletedAt.Add(time.Minute)
		if _, err := s.CheckpointGitEffect(ctx, checkpoint); err != nil {
			t.Fatalf("CheckpointGitEffect(exact retry): %v", err)
		}
		detail, err := s.TargetRunDetail(ctx, runID)
		if err != nil {
			t.Fatalf("TargetRunDetail: %v", err)
		}
		if len(detail.Steps) != 1 || !detail.Steps[0].Step.EndedAt.Equal(firstCompletedAt) {
			t.Fatalf("Git checkpoint retry Step = %+v, want original ended_at %s", detail.Steps, firstCompletedAt)
		}
		checkpoint.PullRequestNumber = 8
		if _, err := s.CheckpointGitEffect(ctx, checkpoint); !errors.Is(err, work.ErrPermanent) {
			t.Fatalf("CheckpointGitEffect(conflict) error = %v, want permanent", err)
		}
	})

	t.Run("git checkpoint requires its owned running step", func(t *testing.T) {
		s, _, runID, startedAt := claimedRun(t, newStore(t))
		ctx := context.Background()
		checkpoint := store.GitCheckpointInput{GitCheckpoint: store.GitCheckpoint{RunID: runID, StepOrdinal: 1, Branch: "factory/contract", PushedHead: "head-1", ObservedBase: "base-1", PullRequestNumber: 7, PullRequestNodeID: "node-7", StepResult: []byte(`{"kind":"synced"}`)}, CompletedAt: startedAt.Add(time.Minute)}
		if _, err := s.CheckpointGitEffect(ctx, checkpoint); err == nil {
			t.Fatal("CheckpointGitEffect without Step succeeded")
		}
		if _, err := s.StartStep(ctx, store.StartStepInput{RunID: runID, Ordinal: 1, Kind: work.StepSyncPullRequest, StartedAt: startedAt}); err != nil {
			t.Fatalf("StartStep: %v", err)
		}
		if _, err := s.CompleteStep(ctx, runID, 1, startedAt.Add(30*time.Second), []byte(`{"kind":"other"}`)); err != nil {
			t.Fatalf("CompleteStep: %v", err)
		}
		if _, err := s.CheckpointGitEffect(ctx, checkpoint); !errors.Is(err, work.ErrPermanent) {
			t.Fatalf("CheckpointGitEffect for completed Step error = %v, want permanent", err)
		}
		checkpoint.StepOrdinal = 2
		if _, err := s.StartStep(ctx, store.StartStepInput{RunID: runID, Ordinal: 2, Kind: work.StepSyncPullRequest, StartedAt: startedAt}); err != nil {
			t.Fatalf("StartStep(same result): %v", err)
		}
		if _, err := s.CompleteStep(ctx, runID, 2, startedAt.Add(30*time.Second), checkpoint.StepResult); err != nil {
			t.Fatalf("CompleteStep(same result): %v", err)
		}
		if _, err := s.CheckpointGitEffect(ctx, checkpoint); !errors.Is(err, work.ErrPermanent) {
			t.Fatalf("CheckpointGitEffect for pre-completed matching Step error = %v, want permanent", err)
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
		secondStep := store.StartStepInput{RunID: secondRunID, Ordinal: 1, Kind: work.StepImplement, StartedAt: startedAt.Add(2 * time.Minute)}
		if _, err := s.StartStep(ctx, secondStep); err != nil {
			t.Fatalf("StartStep(second implement): %v", err)
		}
		secondAttempt := store.StartAgentAttemptInput{ID: store.TargetAttemptID{RunID: secondRunID, StepOrdinal: 1, AttemptNo: 1}, AgentStage: work.AgentStageImplement, Model: work.Model{Name: "contract-model", Effort: "medium"}, UsageState: work.UsageUnknown, StartedAt: startedAt.Add(2 * time.Minute)}
		if _, err := s.StartAgentAttempt(ctx, secondAttempt); err != nil {
			t.Fatalf("StartAgentAttempt(second): %v", err)
		}
		if err := s.BindCheckpointCapability(ctx, secondAttempt.ID, "second-capability"); err != nil {
			t.Fatalf("BindCheckpointCapability(second): %v", err)
		}
		secondGitStep := store.StartStepInput{RunID: secondRunID, Ordinal: 2, Kind: work.StepSyncPullRequest, StartedAt: startedAt.Add(2 * time.Minute)}
		if _, err := s.StartStep(ctx, secondGitStep); err != nil {
			t.Fatalf("StartStep(second git): %v", err)
		}
		secondGit := store.GitCheckpointInput{GitCheckpoint: store.GitCheckpoint{RunID: secondRunID, StepOrdinal: 2, Branch: "factory/second", PushedHead: "second-head", ObservedBase: "base", PullRequestNumber: 2, PullRequestNodeID: "node-2", StepResult: []byte(`{"kind":"synced"}`)}, CompletedAt: startedAt.Add(2 * time.Minute)}
		if _, err := s.CheckpointGitEffect(ctx, secondGit); err != nil {
			t.Fatalf("CheckpointGitEffect(second): %v", err)
		}
		secondMergeStep := store.StartStepInput{RunID: secondRunID, Ordinal: 3, Kind: work.StepMergePullRequest, StartedAt: startedAt.Add(2 * time.Minute)}
		if _, err := s.StartStep(ctx, secondMergeStep); err != nil {
			t.Fatalf("StartStep(second merge): %v", err)
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
		assertOwnership := func(operation string, err error) {
			t.Helper()
			if !errors.Is(err, store.ErrRunOwnership) {
				t.Fatalf("%s after fence error = %v, want ErrRunOwnership", operation, err)
			}
		}
		_, err = s.StartStep(ctx, store.StartStepInput{RunID: secondRunID, Ordinal: 4, Kind: work.StepPlan, StartedAt: startedAt.Add(4 * time.Minute)})
		assertOwnership("StartStep", err)
		_, err = s.CompleteStep(ctx, secondRunID, 1, startedAt.Add(4*time.Minute), []byte(`{"kind":"implemented"}`))
		assertOwnership("CompleteStep", err)
		secondAttempt.ID.AttemptNo = 2
		_, err = s.StartAgentAttempt(ctx, secondAttempt)
		assertOwnership("StartAgentAttempt", err)
		assertOwnership("BindCheckpointCapability", s.BindCheckpointCapability(ctx, store.TargetAttemptID{RunID: secondRunID, StepOrdinal: 1, AttemptNo: 1}, "second-capability"))
		_, err = s.CheckpointAgentAttempt(ctx, store.AgentCheckpointInput{ID: store.TargetAttemptID{RunID: secondRunID, StepOrdinal: 1, AttemptNo: 1}, Capability: "second-capability", ThreadID: "second-thread", State: work.AgentAttemptSucceeded, UsageState: work.UsageMeasured, EndedAt: startedAt.Add(4 * time.Minute), Result: []byte(`{"kind":"done"}`), Transcript: &store.TargetTranscript{CompressedBytes: []byte("transcript"), Compression: "zstd", UncompressedSizeBytes: 10, Checksum: []byte("checksum")}})
		assertOwnership("CheckpointAgentAttempt", err)
		_, err = s.CheckpointGitEffect(ctx, secondGit)
		assertOwnership("CheckpointGitEffect", err)
		_, err = s.CancelRun(ctx, store.CancelRunInput{RunID: secondRunID, TicketID: ticket.ID, EndedAt: startedAt.Add(4 * time.Minute)})
		assertOwnership("CancelRun", err)
		_, err = s.FinalizeConfirmedMerge(ctx, store.ConfirmedMergeInput{RunID: secondRunID, TicketID: ticket.ID, StepOrdinal: 3, ReviewedHead: "second-head", MergeSHA: "second-merge", EndedAt: startedAt.Add(4 * time.Minute)})
		assertOwnership("FinalizeConfirmedMerge", err)
		_, err = s.ReconcileAbandonedRun(ctx, secondRunID, ticket.ID)
		assertOwnership("ReconcileAbandonedRun", err)
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
