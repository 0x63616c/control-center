package store_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// These are the first S3 tracer bullets: every assertion goes through Store,
// against migrated Postgres, rather than reaching into a table.
func TestClaimAndStartRunKeepsOneActiveOwner(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	ticket, err := s.CreateTicket(ctx, "claim", "", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	startedAt := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	firstID := newTestRunID(t)
	first, err := s.ClaimAndStartRun(ctx, store.ClaimRunInput{TicketID: ticket.ID, RunID: firstID, StartedAt: startedAt})
	if err != nil {
		t.Fatalf("ClaimAndStartRun(first): %v", err)
	}
	if first.Ticket.State != store.TicketActive || first.Ticket.ActiveRunID != firstID {
		t.Fatalf("first claim ticket = %+v, want active owner %s", first.Ticket, firstID)
	}
	if _, err := s.ClaimAndStartRun(ctx, store.ClaimRunInput{TicketID: ticket.ID, RunID: firstID, StartedAt: startedAt}); err != nil {
		t.Fatalf("ClaimAndStartRun(retry): %v", err)
	}
	_, err = s.ClaimAndStartRun(ctx, store.ClaimRunInput{TicketID: ticket.ID, RunID: newTestRunID(t), StartedAt: startedAt})
	if !errors.Is(err, store.ErrTicketClaimed) {
		t.Fatalf("ClaimAndStartRun(conflict) error = %v, want ErrTicketClaimed", err)
	}
}

func TestClaimAndStartRunSerializesRacingOwners(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	ticket, err := s.CreateTicket(ctx, "race", "", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	startedAt := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	inputs := []store.ClaimRunInput{{TicketID: ticket.ID, RunID: newTestRunID(t), StartedAt: startedAt}, {TicketID: ticket.ID, RunID: newTestRunID(t), StartedAt: startedAt}}
	start := make(chan struct{})
	errs := make(chan error, len(inputs))
	var group sync.WaitGroup
	for _, in := range inputs {
		group.Add(1)
		go func(in store.ClaimRunInput) {
			defer group.Done()
			<-start
			_, err := s.ClaimAndStartRun(ctx, in)
			errs <- err
		}(in)
	}
	close(start)
	group.Wait()
	close(errs)
	var successes, conflicts int
	for err := range errs {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, store.ErrTicketClaimed):
			conflicts++
		default:
			t.Fatalf("claim error = %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("claims: %d successes, %d conflicts; want 1 each", successes, conflicts)
	}
}

func TestConfirmedMergeFinalizationIsIrreversible(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	upstream, err := s.CreateTicket(ctx, "upstream", "", nil)
	if err != nil {
		t.Fatalf("CreateTicket(upstream): %v", err)
	}
	dependent, err := s.CreateTicket(ctx, "dependent", "", []store.TicketID{upstream.ID})
	if err != nil {
		t.Fatalf("CreateTicket(dependent): %v", err)
	}
	runID := newTestRunID(t)
	startedAt := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	if _, err := s.ClaimAndStartRun(ctx, store.ClaimRunInput{TicketID: upstream.ID, RunID: runID, StartedAt: startedAt}); err != nil {
		t.Fatalf("ClaimAndStartRun: %v", err)
	}
	if _, err := s.StartStep(ctx, store.StartStepInput{RunID: runID, Ordinal: 1, Kind: work.StepMergePullRequest, StartedAt: startedAt}); err != nil {
		t.Fatalf("StartStep: %v", err)
	}
	result, err := s.FinalizeConfirmedMerge(ctx, store.ConfirmedMergeInput{RunID: runID, TicketID: upstream.ID, StepOrdinal: 1, ReviewedHead: "h1", MergeSHA: "m1", EndedAt: startedAt.Add(time.Minute)})
	if err != nil {
		t.Fatalf("FinalizeConfirmedMerge: %v", err)
	}
	if result.Ticket.State != store.TicketDone || result.Run.TargetOutcome != work.RunOutcomeSucceeded || result.Run.MergeSHA != "m1" {
		t.Fatalf("final result = %+v, want done successful m1", result)
	}
	if _, err := s.FinalizeConfirmedMerge(ctx, store.ConfirmedMergeInput{RunID: runID, TicketID: upstream.ID, StepOrdinal: 1, ReviewedHead: "h1", MergeSHA: "m1", EndedAt: startedAt.Add(time.Minute)}); err != nil {
		t.Fatalf("FinalizeConfirmedMerge(retry): %v", err)
	}
	if _, err := s.FinalizeConfirmedMerge(ctx, store.ConfirmedMergeInput{RunID: runID, TicketID: upstream.ID, StepOrdinal: 1, ReviewedHead: "h1", MergeSHA: "m2", EndedAt: startedAt.Add(time.Minute)}); !errors.Is(err, work.ErrPermanent) {
		t.Fatalf("FinalizeConfirmedMerge(conflict) error = %v, want permanent", err)
	}
	if _, err := s.CancelRun(ctx, store.CancelRunInput{RunID: runID, TicketID: upstream.ID, EndedAt: startedAt.Add(2 * time.Minute)}); err != nil {
		t.Fatalf("CancelRun(after merge): %v", err)
	}
	got, err := s.Ticket(ctx, upstream.ID)
	if err != nil {
		t.Fatalf("Ticket: %v", err)
	}
	if got.State != store.TicketDone {
		t.Fatalf("Ticket state = %s, want done", got.State)
	}
	ready, err := s.ReadyTickets(ctx)
	if err != nil {
		t.Fatalf("ReadyTickets: %v", err)
	}
	if !containsTicket(ready, dependent.ID) {
		t.Fatalf("ReadyTickets() = %+v, want dependent", ready)
	}
}

func TestCancellationOnlyReopensItsActiveOwner(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	ticket, err := s.CreateTicket(ctx, "cancel", "", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	runID := newTestRunID(t)
	startedAt := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	if _, err := s.ClaimAndStartRun(ctx, store.ClaimRunInput{TicketID: ticket.ID, RunID: runID, StartedAt: startedAt}); err != nil {
		t.Fatalf("ClaimAndStartRun: %v", err)
	}
	result, err := s.CancelRun(ctx, store.CancelRunInput{RunID: runID, TicketID: ticket.ID, EndedAt: startedAt.Add(time.Minute)})
	if err != nil {
		t.Fatalf("CancelRun: %v", err)
	}
	if result.Run.TargetOutcome != work.RunOutcomeCanceled || result.Ticket.State != store.TicketOpen || result.Ticket.ActiveRunID != "" {
		t.Fatalf("CancelRun = %+v, want canceled and reopened", result)
	}
	if _, err := s.CancelRun(ctx, store.CancelRunInput{RunID: runID, TicketID: ticket.ID, EndedAt: startedAt.Add(time.Minute)}); err != nil {
		t.Fatalf("CancelRun(retry): %v", err)
	}
}

func TestMaintenanceReopensAbandonedOwnershipWithoutClosingTheRun(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	ticket, err := s.CreateTicket(ctx, "abandoned", "", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	runID := newTestRunID(t)
	startedAt := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	if _, err := s.ClaimAndStartRun(ctx, store.ClaimRunInput{TicketID: ticket.ID, RunID: runID, StartedAt: startedAt}); err != nil {
		t.Fatalf("ClaimAndStartRun: %v", err)
	}
	reconciled, err := s.ReconcileAbandonedRun(ctx, runID, ticket.ID)
	if err != nil {
		t.Fatalf("ReconcileAbandonedRun: %v", err)
	}
	if !reconciled {
		t.Fatal("ReconcileAbandonedRun = false, want true")
	}
	run, err := s.Run(ctx, runID)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if run.TargetOutcome != "" {
		t.Fatalf("Run target outcome = %q, want no invented terminal result", run.TargetOutcome)
	}
	got, err := s.Ticket(ctx, ticket.ID)
	if err != nil {
		t.Fatalf("Ticket: %v", err)
	}
	if got.State != store.TicketOpen {
		t.Fatalf("Ticket state = %s, want open", got.State)
	}
}

func TestTargetHistoryKeepsInfrastructureAndAgentWorkDistinct(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	ticket, err := s.CreateTicket(ctx, "history", "", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	runID := newTestRunID(t)
	startedAt := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	if _, err := s.ClaimAndStartRun(ctx, store.ClaimRunInput{TicketID: ticket.ID, RunID: runID, StartedAt: startedAt}); err != nil {
		t.Fatalf("ClaimAndStartRun: %v", err)
	}
	if _, err := s.StartStep(ctx, store.StartStepInput{RunID: runID, Ordinal: 1, Kind: work.StepCloneRepository, StartedAt: startedAt}); err != nil {
		t.Fatalf("StartStep(clone): %v", err)
	}
	if _, err := s.CompleteStep(ctx, runID, 1, startedAt.Add(time.Minute), []byte(`{"kind":"cloned"}`)); err != nil {
		t.Fatalf("CompleteStep(clone): %v", err)
	}
	if _, err := s.StartStep(ctx, store.StartStepInput{RunID: runID, Ordinal: 2, Kind: work.StepImplement, Iteration: 1, StartedAt: startedAt.Add(time.Minute)}); err != nil {
		t.Fatalf("StartStep(implement): %v", err)
	}
	if _, err := s.StartAgentAttempt(ctx, store.StartAgentAttemptInput{RunID: runID, StepOrdinal: 2, AttemptNo: 1, AgentStage: work.AgentStageImplement, Model: work.Model{Name: "gpt-5.6-terra", Effort: "medium"}, UsageState: work.UsageMeasured, StartedAt: startedAt.Add(time.Minute)}); err != nil {
		t.Fatalf("StartAgentAttempt(1): %v", err)
	}
	if _, err := s.StartAgentAttempt(ctx, store.StartAgentAttemptInput{RunID: runID, StepOrdinal: 2, AttemptNo: 2, AgentStage: work.AgentStageImplement, Model: work.Model{Name: "gpt-5.6-terra", Effort: "medium"}, UsageState: work.UsageUnknown, StartedAt: startedAt.Add(2 * time.Minute)}); err != nil {
		t.Fatalf("StartAgentAttempt(2): %v", err)
	}
	detail, err := s.TargetRunDetail(ctx, runID)
	if err != nil {
		t.Fatalf("TargetRunDetail: %v", err)
	}
	if len(detail.Steps) != 2 || len(detail.Steps[0].Attempts) != 0 || len(detail.Steps[1].Attempts) != 2 {
		t.Fatalf("TargetRunDetail = %+v, want clone without attempts then two implements", detail)
	}
	if detail.Steps[1].Attempts[0].AttemptNo != 1 || detail.Steps[1].Attempts[1].AttemptNo != 2 {
		t.Fatalf("attempt order = %+v, want 1 then 2", detail.Steps[1].Attempts)
	}
}

func TestCheckpointCapabilityCannotMutateAnotherRunAndGitCheckpointDoesNotRegress(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	first, err := s.CreateTicket(ctx, "one", "", nil)
	if err != nil {
		t.Fatalf("CreateTicket(first): %v", err)
	}
	second, err := s.CreateTicket(ctx, "two", "", nil)
	if err != nil {
		t.Fatalf("CreateTicket(second): %v", err)
	}
	startedAt := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	firstRun, secondRun := newTestRunID(t), newTestRunID(t)
	for _, claim := range []store.ClaimRunInput{{TicketID: first.ID, RunID: firstRun, StartedAt: startedAt}, {TicketID: second.ID, RunID: secondRun, StartedAt: startedAt}} {
		if _, err := s.ClaimAndStartRun(ctx, claim); err != nil {
			t.Fatalf("ClaimAndStartRun: %v", err)
		}
	}
	for _, runID := range []string{firstRun, secondRun} {
		if _, err := s.StartStep(ctx, store.StartStepInput{RunID: runID, Ordinal: 1, Kind: work.StepImplement, StartedAt: startedAt}); err != nil {
			t.Fatalf("StartStep: %v", err)
		}
		if _, err := s.StartAgentAttempt(ctx, store.StartAgentAttemptInput{RunID: runID, StepOrdinal: 1, AttemptNo: 1, AgentStage: work.AgentStageImplement, Model: work.Model{Name: "m", Effort: "medium"}, UsageState: work.UsageUnknown, StartedAt: startedAt}); err != nil {
			t.Fatalf("StartAgentAttempt: %v", err)
		}
	}
	if err := s.SetCheckpointCapabilityHash(ctx, firstRun, store.CheckpointCapabilityHash("first-capability")); err != nil {
		t.Fatalf("SetCheckpointCapabilityHash: %v", err)
	}
	_, err = s.CheckpointAgentAttempt(ctx, store.AgentCheckpointInput{RunID: secondRun, StepOrdinal: 1, AttemptNo: 1, Capability: "first-capability", State: work.AgentAttemptSucceeded, UsageState: work.UsageMeasured, EndedAt: startedAt.Add(time.Minute)})
	if !errors.Is(err, store.ErrRunOwnership) {
		t.Fatalf("cross-run checkpoint error = %v, want ErrRunOwnership", err)
	}
	checkpoint := store.GitCheckpointInput{GitCheckpoint: store.GitCheckpoint{RunID: firstRun, StepOrdinal: 1, Branch: "factory/one", PushedHead: "h1", ObservedBase: "b1", PullRequestNumber: 1, PullRequestNodeID: "node-1", StepResult: []byte(`{"kind":"synced"}`)}, CompletedAt: startedAt.Add(time.Minute)}
	if _, err := s.CheckpointGitEffect(ctx, checkpoint); err != nil {
		t.Fatalf("CheckpointGitEffect: %v", err)
	}
	checkpoint.PushedHead = "old"
	if _, err := s.CheckpointGitEffect(ctx, checkpoint); !errors.Is(err, work.ErrPermanent) {
		t.Fatalf("older git checkpoint error = %v, want permanent", err)
	}
}
