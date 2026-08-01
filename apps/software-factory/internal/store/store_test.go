package store_test

import (
	"context"
	"database/sql"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/config"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/database"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// newTestStore applies every embedded migration against a real PostgreSQL
// database and returns a Store over it, or skips the test — the pattern
// internal/database/migrations_test.go established: database-backed tests
// skip locally, by design, and run for real only where
// config.DatabaseURLEnv is set, which CI's test-software-factory job does.
func newTestStore(t *testing.T) *store.Store {
	t.Helper()
	s, _ := newTestStoreAndPool(t)
	return s
}

func newTestStoreAndPool(t *testing.T) (*store.Store, *pgxpool.Pool) {
	t.Helper()
	databaseURL := config.DatabaseURL()
	if databaseURL == "" {
		t.Skip(config.DatabaseURLEnv + " is not set")
	}

	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatalf("open PostgreSQL connection: %v", err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("close PostgreSQL connection: %v", err)
		}
	})
	ctx := context.Background()
	if err := database.ApplyMigrations(ctx, db); err != nil {
		t.Fatalf("apply embedded migrations: %v", err)
	}

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open PostgreSQL pool: %v", err)
	}
	t.Cleanup(pool.Close)

	return store.New(pool), pool
}

// TestStoreCarriesATicketThroughItsWholeLifecycle runs the same scenario
// storefake's own test does, against a real Postgres database — this is the
// integration coverage the factory ticket refused to write, and it must
// actually execute in CI rather than skip. See newTestStore.
func TestStoreCarriesATicketThroughItsWholeLifecycle(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	blocker, err := s.CreateTicket(ctx, "upstream", "do this first", nil)
	if err != nil {
		t.Fatalf("CreateTicket(blocker): %v", err)
	}
	blocked, err := s.CreateTicket(ctx, "downstream", "needs upstream done", nil)
	if err != nil {
		t.Fatalf("CreateTicket(blocked): %v", err)
	}
	if err := s.AddTicketDependency(ctx, blocker.ID, blocked.ID); err != nil {
		t.Fatalf("AddTicketDependency: %v", err)
	}

	if got, err := s.Ticket(ctx, blocker.ID); err != nil || got.Title != "upstream" {
		t.Fatalf("Ticket(blocker) = %+v, %v", got, err)
	}

	ready, err := s.ReadyTickets(ctx)
	if err != nil {
		t.Fatalf("ReadyTickets: %v", err)
	}
	if !containsTicket(ready, blocker.ID) || containsTicket(ready, blocked.ID) {
		t.Fatalf("ReadyTickets() = %+v, want the blocker ready and the blocked ticket not ready", ready)
	}

	if _, err := s.UpdateTicketState(ctx, blocker.ID, store.TicketDone); err != nil {
		t.Fatalf("UpdateTicketState(blocker, done): %v", err)
	}
	ready, err = s.ReadyTickets(ctx)
	if err != nil {
		t.Fatalf("ReadyTickets after blocker done: %v", err)
	}
	if !containsTicket(ready, blocked.ID) {
		t.Fatalf("ReadyTickets() after blocker done = %+v, want the downstream ticket ready", ready)
	}

	byState, err := s.TicketsByState(ctx, store.TicketDone)
	if err != nil {
		t.Fatalf("TicketsByState: %v", err)
	}
	if !containsTicket(byState, blocker.ID) {
		t.Fatalf("TicketsByState(done) = %+v, want the blocker", byState)
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

	if err := s.RemoveTicketDependency(ctx, blocker.ID, blocked.ID); err != nil {
		t.Fatalf("RemoveTicketDependency: %v", err)
	}
	blocks, err = s.TicketBlocks(ctx, blocker.ID)
	if err != nil {
		t.Fatalf("TicketBlocks after remove: %v", err)
	}
	if len(blocks) != 0 {
		t.Fatalf("TicketBlocks(blocker) after removing the edge = %+v, want none", blocks)
	}

	runID := newTestRunID(t)
	startedAt := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	run, err := s.StartRun(ctx, runID, blocked.ID, startedAt)
	if err != nil {
		t.Fatalf("StartRun: %v", err)
	}
	if run.TicketID != blocked.ID {
		t.Fatalf("StartRun().TicketID = %d, want %d", run.TicketID, blocked.ID)
	}

	key := work.StageKey{Ticket: int(blocked.ID), RunID: runID, Stage: work.StagePlan, Turn: 1}
	if err := s.RecordStep(ctx, key); err != nil {
		t.Fatalf("RecordStep: %v", err)
	}
	// Recording the same step twice must be a no-op (an activity retry does
	// exactly this), not a constraint violation.
	if err := s.RecordStep(ctx, key); err != nil {
		t.Fatalf("RecordStep (retry): %v", err)
	}

	model := work.Model{Name: "gpt-5.6-terra", Effort: "medium"}
	usage := work.Usage{InputTokens: 100, CachedInputTokens: 20, OutputTokens: 50, ReasoningTokens: 10}
	attempt, err := s.RecordAttempt(ctx, key, 1, model, usage, true, startedAt)
	if err != nil {
		t.Fatalf("RecordAttempt: %v", err)
	}
	if attempt.Model != model || attempt.Usage != usage {
		t.Fatalf("RecordAttempt() = %+v, want model %+v usage %+v", attempt, model, usage)
	}

	endedAt := startedAt.Add(5 * time.Minute)
	ended, err := s.EndAttempt(ctx, key, 1, endedAt, store.AttemptSucceeded)
	if err != nil {
		t.Fatalf("EndAttempt: %v", err)
	}
	if ended.Result != store.AttemptSucceeded || ended.EndedAt.IsZero() {
		t.Fatalf("EndAttempt() = %+v, want result succeeded and a non-zero EndedAt", ended)
	}

	attempts, err := s.AttemptsForStep(ctx, key)
	if err != nil {
		t.Fatalf("AttemptsForStep: %v", err)
	}
	if len(attempts) != 1 {
		t.Fatalf("AttemptsForStep() = %+v, want exactly one attempt", attempts)
	}

	transcript := store.Transcript{
		Key: key, AttemptNo: 1,
		CompressedBytes: []byte("compressed-bytes"), Compression: "zstd",
		UncompressedSizeBytes: 1024, Checksum: []byte("checksum-bytes"),
	}
	if err := s.PutTranscript(ctx, transcript); err != nil {
		t.Fatalf("PutTranscript: %v", err)
	}
	gotTranscript, err := s.Transcript(ctx, key, 1)
	if err != nil {
		t.Fatalf("Transcript: %v", err)
	}
	if string(gotTranscript.CompressedBytes) != "compressed-bytes" || gotTranscript.Compression != "zstd" {
		t.Fatalf("Transcript() = %+v, want the stored transcript back", gotTranscript)
	}

	endedRun, err := s.EndRun(ctx, runID, endedAt, work.OutcomeProposed, work.FailureNone)
	if err != nil {
		t.Fatalf("EndRun: %v", err)
	}
	if endedRun.Outcome != work.OutcomeProposed {
		t.Fatalf("EndRun().Outcome = %q, want %q", endedRun.Outcome, work.OutcomeProposed)
	}

	detail, err := s.RunDetail(ctx, runID)
	if err != nil {
		t.Fatalf("RunDetail: %v", err)
	}
	if len(detail.Steps) != 1 || len(detail.Steps[0].Attempts) != 1 {
		t.Fatalf("RunDetail().Steps = %+v, want exactly one step with one attempt", detail.Steps)
	}

	state, err := s.DispatcherState(ctx)
	if err != nil {
		t.Fatalf("DispatcherState: %v", err)
	}
	state.Config = work.DefaultConfig()
	state.Config.Paused = true
	state.InFlight = []work.InFlightTicket{{Ticket: 551, RunID: runID, StartedAt: startedAt}}
	state.Candidates = []int{552, 553}
	state.FreeSlots = 1
	state.WrittenAt = endedAt
	if err := s.PutDispatcherState(ctx, state); err != nil {
		t.Fatalf("PutDispatcherState: %v", err)
	}
	readState, err := s.DispatcherState(ctx)
	if err != nil {
		t.Fatalf("DispatcherState after write: %v", err)
	}
	if !readState.Config.Paused {
		t.Fatal("DispatcherState().Config.Paused = false, want true after PutDispatcherState")
	}
	if len(readState.InFlight) != 1 || readState.InFlight[0].Ticket != 551 {
		t.Fatalf("DispatcherState().InFlight = %+v, want the one in-flight ticket back", readState.InFlight)
	}
	if !slices.Equal(readState.Candidates, []int{552, 553}) {
		t.Fatalf("DispatcherState().Candidates = %v, want [552 553]", readState.Candidates)
	}
	if readState.FreeSlots != 1 {
		t.Fatalf("DispatcherState().FreeSlots = %d, want 1", readState.FreeSlots)
	}
}

func TestReopenLegacyTicketsMovesOnlyWorkingAndReviewInOneOperation(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	working, err := s.CreateTicket(ctx, "working", "legacy", nil)
	if err != nil {
		t.Fatal(err)
	}
	working, err = s.TransitionTicketState(ctx, working.ID, store.TicketOpen, store.TicketWorking)
	if err != nil {
		t.Fatal(err)
	}
	review, err := s.CreateTicket(ctx, "review", "legacy", nil)
	if err != nil {
		t.Fatal(err)
	}
	review, err = s.TransitionTicketState(ctx, review.ID, store.TicketOpen, store.TicketWorking)
	if err != nil {
		t.Fatal(err)
	}
	review, err = s.TransitionTicketState(ctx, review.ID, store.TicketWorking, store.TicketReview)
	if err != nil {
		t.Fatal(err)
	}
	done, err := s.CreateTicket(ctx, "done", "target", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateTicketState(ctx, done.ID, store.TicketDone); err != nil {
		t.Fatal(err)
	}

	reopened, err := s.ReopenLegacyTickets(ctx, []store.Ticket{working, review})
	if err != nil {
		t.Fatalf("ReopenLegacyTickets: %v", err)
	}
	if len(reopened) != 2 || reopened[0].ID != working.ID || reopened[1].ID != review.ID {
		t.Fatalf("reopened = %+v, want working and review tickets", reopened)
	}
	for _, ticket := range reopened {
		if ticket.State != store.TicketOpen {
			t.Errorf("ticket %d state = %s, want open", ticket.ID, ticket.State)
		}
	}
	gotDone, err := s.Ticket(ctx, done.ID)
	if err != nil || gotDone.State != store.TicketDone {
		t.Fatalf("done ticket = %+v, %v; want unchanged", gotDone, err)
	}
}

func TestReopenLegacyTicketsRollsBackEveryRowWhenOneSnapshotIsStale(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	first, err := s.CreateTicket(ctx, "first", "legacy", nil)
	if err != nil {
		t.Fatal(err)
	}
	first, err = s.TransitionTicketState(ctx, first.ID, store.TicketOpen, store.TicketWorking)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.CreateTicket(ctx, "second", "legacy", nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err = s.TransitionTicketState(ctx, second.ID, store.TicketOpen, store.TicketWorking)
	if err != nil {
		t.Fatal(err)
	}
	staleSecond := second
	if _, err := s.TransitionTicketState(ctx, second.ID, store.TicketWorking, store.TicketReview); err != nil {
		t.Fatal(err)
	}

	if _, err := s.ReopenLegacyTickets(ctx, []store.Ticket{first, staleSecond}); err == nil {
		t.Fatal("ReopenLegacyTickets accepted a stale second snapshot")
	}
	gotFirst, err := s.Ticket(ctx, first.ID)
	if err != nil || gotFirst.State != store.TicketWorking {
		t.Fatalf("first Ticket = %+v, %v; want transaction rollback to working", gotFirst, err)
	}
	gotSecond, err := s.Ticket(ctx, second.ID)
	if err != nil || gotSecond.State != store.TicketReview {
		t.Fatalf("second Ticket = %+v, %v; want concurrent review state preserved", gotSecond, err)
	}
}

func TestReconcileLegacyStateClosesRunsAndReopensTicketsAtomically(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	ticket, err := s.CreateTicket(ctx, "legacy cutover", "", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	ticket, err = s.TransitionTicketState(ctx, ticket.ID, store.TicketOpen, store.TicketWorking)
	if err != nil {
		t.Fatalf("TransitionTicketState: %v", err)
	}
	startedAt := time.Date(2026, time.July, 31, 20, 0, 0, 0, time.UTC)
	runID := newTestRunID(t)
	if _, err := s.StartRun(ctx, runID, ticket.ID, startedAt); err != nil {
		t.Fatalf("StartRun: %v", err)
	}
	runs, err := s.OpenLegacyRuns(ctx)
	if err != nil {
		t.Fatalf("OpenLegacyRuns: %v", err)
	}
	if len(runs) != 1 || runs[0].ID != runID {
		t.Fatalf("OpenLegacyRuns = %+v, want %s", runs, runID)
	}
	endedAt := startedAt.Add(time.Hour)
	reopened, err := s.ReconcileLegacyState(ctx, []store.Ticket{ticket}, runs, endedAt)
	if err != nil {
		t.Fatalf("ReconcileLegacyState: %v", err)
	}
	if len(reopened) != 1 || reopened[0].State != store.TicketOpen {
		t.Fatalf("reopened = %+v, want one open Ticket", reopened)
	}
	closed, err := s.Run(ctx, runID)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if closed.EndedAt != endedAt || closed.Outcome != work.OutcomeFailed || closed.Failure != work.FailureOther {
		t.Fatalf("closed Run = %+v, want failed/other at %s", closed, endedAt)
	}
}

func TestCreateTicketCommitsDeclaredBlockersWithTheTicket(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	upstream, err := s.CreateTicket(ctx, "upstream", "finish first", nil)
	if err != nil {
		t.Fatalf("CreateTicket(upstream): %v", err)
	}
	downstream, err := s.CreateTicket(ctx, "downstream", "wait", []store.TicketID{upstream.ID})
	if err != nil {
		t.Fatalf("CreateTicket(downstream): %v", err)
	}

	blockers, err := s.TicketBlockers(ctx, downstream.ID)
	if err != nil {
		t.Fatalf("TicketBlockers(downstream): %v", err)
	}
	if len(blockers) != 1 || blockers[0].ID != upstream.ID {
		t.Fatalf("TicketBlockers(downstream) = %+v, want [%d]", blockers, upstream.ID)
	}
	ready, err := s.ReadyTickets(ctx)
	if err != nil {
		t.Fatalf("ReadyTickets: %v", err)
	}
	if containsTicket(ready, downstream.ID) {
		t.Fatalf("ReadyTickets() = %+v, want downstream excluded until upstream is done", ready)
	}
	before, err := s.Tickets(ctx)
	if err != nil {
		t.Fatalf("Tickets before rejected create: %v", err)
	}
	if _, err := s.CreateTicket(ctx, "invalid", "missing blocker", []store.TicketID{999999999}); err == nil {
		t.Fatal("CreateTicket with missing blocker succeeded")
	}
	after, err := s.Tickets(ctx)
	if err != nil {
		t.Fatalf("Tickets after rejected create: %v", err)
	}
	if len(after) != len(before) {
		t.Fatalf("Tickets after rejected create = %+v, want no ticket persisted", after)
	}
}

// TestAddTicketDependencyRejectsATicketBlockingItself proves the schema's own
// wall — ticket_edge_not_self_check — surfaces through Store as a
// non-retryable error, per SoftwareStyle's error taxonomy: bad input from a
// caller, never fixed by retrying.
func TestAddTicketDependencyRejectsATicketBlockingItself(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	ticket, err := s.CreateTicket(ctx, "self", "b", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	err = s.AddTicketDependency(ctx, ticket.ID, ticket.ID)
	if err == nil {
		t.Fatal("AddTicketDependency(t, t) succeeded, want the self-dependency check to reject it")
	}
	if !errors.Is(err, work.ErrPermanent) {
		t.Fatalf("AddTicketDependency(t, t) error = %v, want a non-retryable (work.ErrPermanent) failure", err)
	}
}

func containsTicket(tickets []store.Ticket, id store.TicketID) bool {
	for _, t := range tickets {
		if t.ID == id {
			return true
		}
	}
	return false
}

// newTestRunID mints a fresh UUID, standing in for the Temporal run id a real
// workflow execution would carry.
func newTestRunID(t *testing.T) string {
	t.Helper()
	return uuid.NewString()
}

// TestRecordingIsIdempotentAgainstARealDatabase proves, against a real
// Postgres rather than storefake, that RecordAttempt and StartRun can be
// safely retried — the queries this ticket added ON CONFLICT ... DO UPDATE
// to, because an activity retry always resends what the first attempt
// carried, and the plain inserts #543 shipped would violate their primary
// keys instead of tolerating that (software-factory#549).
func TestRecordingIsIdempotentAgainstARealDatabase(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	ticket, err := s.CreateTicket(ctx, "recorded", "b", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	runID := newTestRunID(t)
	startedAt := time.Date(2026, 7, 31, 9, 0, 0, 0, time.UTC)

	if _, err := s.StartRun(ctx, runID, ticket.ID, startedAt); err != nil {
		t.Fatalf("StartRun: %v", err)
	}
	if _, err := s.StartRun(ctx, runID, ticket.ID, startedAt); err != nil {
		t.Fatalf("retried StartRun: %v", err)
	}

	key := work.StageKey{RunID: runID, Stage: work.StageImplement, Turn: 1}
	if err := s.RecordStep(ctx, key); err != nil {
		t.Fatalf("RecordStep: %v", err)
	}
	if err := s.RecordStep(ctx, key); err != nil {
		t.Fatalf("retried RecordStep: %v", err)
	}

	model := work.Model{Name: "gpt-5.6-terra", Effort: "medium"}
	usage := work.Usage{InputTokens: 10, OutputTokens: 5}
	if _, err := s.RecordAttempt(ctx, key, 1, model, usage, true, startedAt); err != nil {
		t.Fatalf("RecordAttempt: %v", err)
	}
	if _, err := s.RecordAttempt(ctx, key, 1, model, usage, true, startedAt); err != nil {
		t.Fatalf("retried RecordAttempt: %v", err)
	}

	steps, err := s.RunDetail(ctx, runID)
	if err != nil {
		t.Fatalf("RunDetail: %v", err)
	}
	if len(steps.Steps) != 1 {
		t.Fatalf("Steps = %d, want exactly one — a retry must not duplicate", len(steps.Steps))
	}
	if len(steps.Steps[0].Attempts) != 1 {
		t.Fatalf("Attempts = %d, want exactly one — a retry must not duplicate", len(steps.Steps[0].Attempts))
	}
}

// TestPutTranscriptIsIdempotentAgainstARealDatabase proves, against a real
// Postgres, that persisting the same Attempt's transcript twice — an
// activity retry — does not violate the transcript table's primary key
// (software-factory#550's own ON CONFLICT DO NOTHING fix to #543's plain
// insert).
func TestPutTranscriptIsIdempotentAgainstARealDatabase(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	ticket, err := s.CreateTicket(ctx, "transcript owner", "b", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	runID := newTestRunID(t)
	startedAt := time.Date(2026, 7, 31, 9, 0, 0, 0, time.UTC)
	if _, err := s.StartRun(ctx, runID, ticket.ID, startedAt); err != nil {
		t.Fatalf("StartRun: %v", err)
	}
	key := work.StageKey{RunID: runID, Stage: work.StagePlan, Turn: 1}
	if err := s.RecordStep(ctx, key); err != nil {
		t.Fatalf("RecordStep: %v", err)
	}
	if _, err := s.RecordAttempt(ctx, key, 1, work.Model{Name: "m", Effort: "medium"}, work.Usage{}, true, startedAt); err != nil {
		t.Fatalf("RecordAttempt: %v", err)
	}

	transcript := store.Transcript{
		Key: key, AttemptNo: 1,
		CompressedBytes:       []byte("compressed"),
		Compression:           "gzip",
		UncompressedSizeBytes: 9,
		Checksum:              []byte{1, 2, 3},
	}
	if err := s.PutTranscript(ctx, transcript); err != nil {
		t.Fatalf("PutTranscript: %v", err)
	}
	if err := s.PutTranscript(ctx, transcript); err != nil {
		t.Fatalf("retried PutTranscript: %v", err)
	}

	got, err := s.Transcript(ctx, key, 1)
	if err != nil {
		t.Fatalf("Transcript: %v", err)
	}
	if string(got.CompressedBytes) != "compressed" {
		t.Fatalf("CompressedBytes = %q, want %q", got.CompressedBytes, "compressed")
	}
}

// TestRecordWebhookDeliveryAndTransitionAgainstARealDatabase proves the
// transactional idempotency #557 needs against real Postgres, not just
// storefake's in-memory mirror: a fresh delivery applies the Ticket
// transition, and redelivering the same id is a no-op that neither errors
// nor repeats the transition.
func TestRecordWebhookDeliveryAndTransitionAgainstARealDatabase(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	ticket, err := s.CreateTicket(ctx, "webhook ticket", "b", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	if _, err := s.TransitionTicketState(ctx, ticket.ID, store.TicketOpen, store.TicketWorking); err != nil {
		t.Fatalf("TransitionTicketState(open, working): %v", err)
	}
	if _, err := s.TransitionTicketState(ctx, ticket.ID, store.TicketWorking, store.TicketReview); err != nil {
		t.Fatalf("TransitionTicketState(working, review): %v", err)
	}

	deliveryID := "delivery-" + newTestRunID(t)
	outcome, err := s.RecordWebhookDeliveryAndTransition(ctx, deliveryID, ticket.ID, store.TicketReview, store.TicketDone)
	if err != nil {
		t.Fatalf("RecordWebhookDeliveryAndTransition: %v", err)
	}
	if outcome != store.WebhookDeliveryApplied {
		t.Fatalf("outcome = %v, want WebhookDeliveryApplied", outcome)
	}
	got, err := s.Ticket(ctx, ticket.ID)
	if err != nil {
		t.Fatalf("Ticket: %v", err)
	}
	if got.State != store.TicketDone {
		t.Fatalf("ticket state = %s, want done", got.State)
	}

	outcome, err = s.RecordWebhookDeliveryAndTransition(ctx, deliveryID, ticket.ID, store.TicketReview, store.TicketDone)
	if err != nil {
		t.Fatalf("redelivered RecordWebhookDeliveryAndTransition: %v", err)
	}
	if outcome != store.WebhookDeliveryDuplicate {
		t.Fatalf("redelivered outcome = %v, want WebhookDeliveryDuplicate", outcome)
	}
	got, err = s.Ticket(ctx, ticket.ID)
	if err != nil {
		t.Fatalf("Ticket after redelivery: %v", err)
	}
	if got.State != store.TicketDone {
		t.Fatalf("ticket state after redelivery = %s, want still done", got.State)
	}
}

// TestRecordWebhookDeliveryAndTransitionIsStaleWhenTheTicketAlreadyMovedOn
// proves a delivery still gets recorded seen even when the Ticket is no
// longer in the expected `from` state — a human, or an earlier delivery,
// already moved it.
func TestRecordWebhookDeliveryAndTransitionIsStaleWhenTheTicketAlreadyMovedOn(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	ticket, err := s.CreateTicket(ctx, "already done", "b", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}

	outcome, err := s.RecordWebhookDeliveryAndTransition(ctx, "delivery-"+newTestRunID(t), ticket.ID, store.TicketReview, store.TicketDone)
	if err != nil {
		t.Fatalf("RecordWebhookDeliveryAndTransition: %v", err)
	}
	if outcome != store.WebhookDeliveryStale {
		t.Fatalf("outcome = %v, want WebhookDeliveryStale", outcome)
	}
	got, err := s.Ticket(ctx, ticket.ID)
	if err != nil {
		t.Fatalf("Ticket: %v", err)
	}
	if got.State != store.TicketOpen {
		t.Fatalf("ticket state = %s, want unchanged (open)", got.State)
	}
}
