package storefake_test

import (
	"context"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store/storefake"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// This test never opens a database — it is the one SoftwareStyle requires:
// every consumer built on top of internal/store must be testable without
// Postgres, and this is the fake proving it can carry a whole ticket's
// lifecycle end to end.
func TestFakeStoreCarriesATicketThroughItsWholeLifecycle(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	s := storefake.New()

	blocker, err := s.CreateTicket(ctx, "upstream", "do this first")
	if err != nil {
		t.Fatalf("CreateTicket(blocker): %v", err)
	}
	blocked, err := s.CreateTicket(ctx, "downstream", "needs upstream done")
	if err != nil {
		t.Fatalf("CreateTicket(blocked): %v", err)
	}
	if err := s.AddTicketDependency(ctx, blocker.ID, blocked.ID); err != nil {
		t.Fatalf("AddTicketDependency: %v", err)
	}

	ready, err := s.ReadyTickets(ctx)
	if err != nil {
		t.Fatalf("ReadyTickets: %v", err)
	}
	if len(ready) != 1 || ready[0].ID != blocker.ID {
		t.Fatalf("ReadyTickets() = %+v, want only the unblocked ticket %d", ready, blocker.ID)
	}

	if _, err := s.UpdateTicketState(ctx, blocker.ID, store.TicketDone); err != nil {
		t.Fatalf("UpdateTicketState(blocker, done): %v", err)
	}
	ready, err = s.ReadyTickets(ctx)
	if err != nil {
		t.Fatalf("ReadyTickets after blocker done: %v", err)
	}
	if len(ready) != 1 || ready[0].ID != blocked.ID {
		t.Fatalf("ReadyTickets() after blocker done = %+v, want the downstream ticket %d ready", ready, blocked.ID)
	}

	blockers, err := s.TicketBlockers(ctx, blocked.ID)
	if err != nil {
		t.Fatalf("TicketBlockers: %v", err)
	}
	if len(blockers) != 1 || blockers[0].ID != blocker.ID {
		t.Fatalf("TicketBlockers(blocked) = %+v, want [%d]", blockers, blocker.ID)
	}
	blocks, err := s.TicketBlocks(ctx, blocker.ID)
	if err != nil {
		t.Fatalf("TicketBlocks: %v", err)
	}
	if len(blocks) != 1 || blocks[0].ID != blocked.ID {
		t.Fatalf("TicketBlocks(blocker) = %+v, want [%d]", blocks, blocked.ID)
	}

	runID := "11111111-1111-1111-1111-111111111111"
	startedAt := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	if _, err := s.StartRun(ctx, runID, blocked.ID, startedAt); err != nil {
		t.Fatalf("StartRun: %v", err)
	}

	key := work.StageKey{Ticket: int(blocked.ID), RunID: runID, Stage: work.StagePlan, Turn: 1}
	if err := s.RecordStep(ctx, key); err != nil {
		t.Fatalf("RecordStep: %v", err)
	}
	model := work.Model{Name: "gpt-5.6-terra", Effort: "medium"}
	usage := work.Usage{InputTokens: 100, CachedInputTokens: 20, OutputTokens: 50, ReasoningTokens: 10}
	if _, err := s.RecordAttempt(ctx, key, 1, model, usage, true, startedAt); err != nil {
		t.Fatalf("RecordAttempt: %v", err)
	}
	endedAt := startedAt.Add(5 * time.Minute)
	if _, err := s.EndAttempt(ctx, key, 1, endedAt, store.AttemptSucceeded); err != nil {
		t.Fatalf("EndAttempt: %v", err)
	}

	transcript := store.Transcript{
		Key: key, AttemptNo: 1,
		CompressedBytes: []byte("compressed"), Compression: "zstd",
		UncompressedSizeBytes: 42, Checksum: []byte("checksum"),
	}
	if err := s.PutTranscript(ctx, transcript); err != nil {
		t.Fatalf("PutTranscript: %v", err)
	}
	got, err := s.Transcript(ctx, key, 1)
	if err != nil {
		t.Fatalf("Transcript: %v", err)
	}
	if string(got.CompressedBytes) != "compressed" || got.Compression != "zstd" {
		t.Fatalf("Transcript() = %+v, want the stored transcript back", got)
	}

	if _, err := s.EndRun(ctx, runID, endedAt, work.OutcomeProposed, work.FailureNone); err != nil {
		t.Fatalf("EndRun: %v", err)
	}

	detail, err := s.RunDetail(ctx, runID)
	if err != nil {
		t.Fatalf("RunDetail: %v", err)
	}
	if detail.Run.Outcome != work.OutcomeProposed {
		t.Fatalf("RunDetail().Run.Outcome = %q, want %q", detail.Run.Outcome, work.OutcomeProposed)
	}
	if len(detail.Steps) != 1 || len(detail.Steps[0].Attempts) != 1 {
		t.Fatalf("RunDetail().Steps = %+v, want exactly one step with one attempt", detail.Steps)
	}
	if detail.Steps[0].Attempts[0].Result != store.AttemptSucceeded {
		t.Fatalf("RunDetail() attempt result = %q, want %q", detail.Steps[0].Attempts[0].Result, store.AttemptSucceeded)
	}

	state := store.DispatcherState{
		MaxInFlight: 2,
		InFlight:    []store.InFlightTicket{{TicketID: blocked.ID, RunID: runID, StartedAt: startedAt}},
		WrittenAt:   endedAt,
	}
	if err := s.PutDispatcherState(ctx, state); err != nil {
		t.Fatalf("PutDispatcherState: %v", err)
	}
	readState, err := s.DispatcherState(ctx)
	if err != nil {
		t.Fatalf("DispatcherState: %v", err)
	}
	if len(readState.InFlight) != 1 || readState.InFlight[0].TicketID != blocked.ID {
		t.Fatalf("DispatcherState().InFlight = %+v, want the one in-flight ticket back", readState.InFlight)
	}
}

// A resumed attempt reports Measured false with a zero Usage, and that must
// stay distinguishable from a real zero-token measurement (#426) — the reason
// Measured exists on Attempt at all.
func TestFakeStoreDistinguishesUnmeasuredFromZero(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	s := storefake.New()

	ticket, err := s.CreateTicket(ctx, "t", "b")
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	runID := "22222222-2222-2222-2222-222222222222"
	startedAt := time.Date(2026, 7, 30, 13, 0, 0, 0, time.UTC)
	if _, err := s.StartRun(ctx, runID, ticket.ID, startedAt); err != nil {
		t.Fatalf("StartRun: %v", err)
	}
	key := work.StageKey{Ticket: int(ticket.ID), RunID: runID, Stage: work.StageImplement, Turn: 1}
	if err := s.RecordStep(ctx, key); err != nil {
		t.Fatalf("RecordStep: %v", err)
	}

	resumed, err := s.RecordAttempt(ctx, key, 1, work.Model{Name: "m", Effort: "low"}, work.Usage{}, false, startedAt)
	if err != nil {
		t.Fatalf("RecordAttempt(resumed): %v", err)
	}
	if resumed.Measured {
		t.Fatal("resumed attempt reports Measured = true, want false")
	}
	if resumed.Usage != (work.Usage{}) {
		t.Fatalf("resumed attempt Usage = %+v, want zero", resumed.Usage)
	}

	measured, err := s.RecordAttempt(ctx, key, 2, work.Model{Name: "m", Effort: "low"}, work.Usage{}, true, startedAt)
	if err != nil {
		t.Fatalf("RecordAttempt(measured): %v", err)
	}
	if !measured.Measured {
		t.Fatal("measured attempt reports Measured = false, want true")
	}
}

func TestFakeStoreDerivesReadinessFromEveryDirectBlocker(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	s := storefake.New()
	done, err := s.CreateTicket(ctx, "done", "")
	if err != nil {
		t.Fatalf("CreateTicket(done): %v", err)
	}
	open, err := s.CreateTicket(ctx, "open", "")
	if err != nil {
		t.Fatalf("CreateTicket(open): %v", err)
	}
	failed, err := s.CreateTicket(ctx, "failed", "")
	if err != nil {
		t.Fatalf("CreateTicket(failed): %v", err)
	}
	mixed, err := s.CreateTicket(ctx, "mixed", "")
	if err != nil {
		t.Fatalf("CreateTicket(mixed): %v", err)
	}
	onlyDone, err := s.CreateTicket(ctx, "only done", "")
	if err != nil {
		t.Fatalf("CreateTicket(onlyDone): %v", err)
	}
	onlyFailed, err := s.CreateTicket(ctx, "only failed", "")
	if err != nil {
		t.Fatalf("CreateTicket(onlyFailed): %v", err)
	}
	if _, err := s.UpdateTicketState(ctx, done.ID, store.TicketDone); err != nil {
		t.Fatalf("UpdateTicketState(done): %v", err)
	}
	if _, err := s.UpdateTicketState(ctx, failed.ID, store.TicketFailed); err != nil {
		t.Fatalf("UpdateTicketState(failed): %v", err)
	}
	for _, edge := range [][2]store.TicketID{{done.ID, mixed.ID}, {open.ID, mixed.ID}, {done.ID, onlyDone.ID}, {failed.ID, onlyFailed.ID}} {
		if err := s.AddTicketDependency(ctx, edge[0], edge[1]); err != nil {
			t.Fatalf("AddTicketDependency(%d, %d): %v", edge[0], edge[1], err)
		}
	}
	ready, err := s.ReadyTickets(ctx)
	if err != nil {
		t.Fatalf("ReadyTickets: %v", err)
	}
	if containsID(ready, mixed.ID) || containsID(ready, onlyFailed.ID) || !containsID(ready, onlyDone.ID) {
		t.Fatalf("ReadyTickets() = %+v, want only-done ready and mixed/failed blocked", ready)
	}
}

func containsID(tickets []store.Ticket, id store.TicketID) bool {
	for _, ticket := range tickets {
		if ticket.ID == id {
			return true
		}
	}
	return false
}
