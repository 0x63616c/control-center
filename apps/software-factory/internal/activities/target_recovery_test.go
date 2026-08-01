package activities

import (
	"context"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store/storefake"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

func TestTargetRecoveryReturnsOnlyCanceledPredecessorCheckpoint(t *testing.T) {
	ctx := context.Background()
	fake := storefake.New()
	now := time.Date(2026, 7, 31, 23, 0, 0, 0, time.UTC)
	ticket, err := fake.CreateTicket(ctx, "carry forward", "", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	runID := "0f466627-b3ae-4ba2-9c96-6ef44ec6f578"
	if _, err := fake.ClaimAndStartRun(ctx, store.ClaimRunInput{TicketID: ticket.ID, RunID: runID, StartedAt: now}); err != nil {
		t.Fatalf("ClaimAndStartRun: %v", err)
	}
	if _, err := fake.StartStep(ctx, store.StartStepInput{RunID: runID, Ordinal: 1, Kind: work.StepCloneRepository, StartedAt: now}); err != nil {
		t.Fatalf("StartStep: %v", err)
	}
	checkpoint := store.GitCheckpoint{RunID: runID, StepOrdinal: 1, Branch: "factory/ticket-1/old", PushedHead: "0123456789abcdef0123456789abcdef01234567"}
	if _, err := fake.CheckpointGitEffect(ctx, store.GitCheckpointInput{GitCheckpoint: checkpoint, CompletedAt: now}); err != nil {
		t.Fatalf("CheckpointGitEffect: %v", err)
	}
	if _, err := fake.CancelRun(ctx, store.CancelRunInput{RunID: runID, TicketID: ticket.ID, EndedAt: now}); err != nil {
		t.Fatalf("CancelRun: %v", err)
	}
	activities, err := NewTargetRecoveryActivities(fake)
	if err != nil {
		t.Fatalf("NewTargetRecoveryActivities: %v", err)
	}
	got, err := activities.LatestCanceledRunCheckpoint(ctx, ticket.ID, "a291ce2b-4d33-4e83-af55-110020ff1318")
	if err != nil {
		t.Fatalf("LatestCanceledRunCheckpoint: %v", err)
	}
	if !got.Found || got.Checkpoint.PushedHead != checkpoint.PushedHead || got.Checkpoint.Branch != checkpoint.Branch {
		t.Fatalf("recovery checkpoint = %+v", got)
	}
}
