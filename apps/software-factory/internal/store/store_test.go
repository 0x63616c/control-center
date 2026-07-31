package store_test

import (
	"context"
	"database/sql"
	"errors"
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

	return store.New(pool)
}

// TestStoreCarriesATicketThroughItsWholeLifecycle runs the same scenario
// storefake's own test does, against a real Postgres database — this is the
// integration coverage the factory ticket refused to write, and it must
// actually execute in CI rather than skip. See newTestStore.
func TestStoreCarriesATicketThroughItsWholeLifecycle(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

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
	state.Paused = true
	state.InFlight = []store.InFlightTicket{{TicketID: blocked.ID, RunID: runID, StartedAt: startedAt}}
	state.WrittenAt = endedAt
	if err := s.PutDispatcherState(ctx, state); err != nil {
		t.Fatalf("PutDispatcherState: %v", err)
	}
	readState, err := s.DispatcherState(ctx)
	if err != nil {
		t.Fatalf("DispatcherState after write: %v", err)
	}
	if !readState.Paused {
		t.Fatal("DispatcherState().Paused = false, want true after PutDispatcherState")
	}
	if len(readState.InFlight) != 1 || readState.InFlight[0].TicketID != blocked.ID {
		t.Fatalf("DispatcherState().InFlight = %+v, want the one in-flight ticket back", readState.InFlight)
	}
}

// TestAddTicketDependencyRejectsATicketBlockingItself proves the schema's own
// wall — ticket_edge_not_self_check — surfaces through Store as a
// non-retryable error, per SoftwareStyle's error taxonomy: bad input from a
// caller, never fixed by retrying.
func TestAddTicketDependencyRejectsATicketBlockingItself(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	ticket, err := s.CreateTicket(ctx, "self", "b")
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

	ticket, err := s.CreateTicket(ctx, "recorded", "b")
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

	ticket, err := s.CreateTicket(ctx, "transcript owner", "b")
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
