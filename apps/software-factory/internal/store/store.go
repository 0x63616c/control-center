package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store/sqlc"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store is the concrete PostgreSQL record door. Its zero value is unusable.
type Store struct {
	pool    *pgxpool.Pool
	queries *sqlc.Queries
}

// New opens the factory record store at databaseURL.
func New(ctx context.Context, databaseURL string) (*Store, error) {
	if databaseURL == "" {
		return nil, fmt.Errorf("open store: database URL is required")
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open store: %w", err)
	}
	return &Store{pool: pool, queries: sqlc.New(pool)}, nil
}

// Close releases the store's database connections.
func (s *Store) Close() { s.pool.Close() }

// MigrationProbeExists reports whether the migration smoke-test table exists.
func (s *Store) MigrationProbeExists(ctx context.Context) (bool, error) {
	v, err := s.queries.MigrationProbeExists(ctx)
	if err != nil {
		return false, queryError("read migration probe", err)
	}
	return v, nil
}

// CreateTicket records a new factory ticket.
func (s *Store) CreateTicket(ctx context.Context, title, body string) (work.FactoryTicket, error) {
	r, err := s.queries.CreateTicket(ctx, sqlc.CreateTicketParams{Title: title, Body: body, State: string(work.TicketStateOpen)})
	if err != nil {
		return work.FactoryTicket{}, queryError("create ticket", err)
	}
	return ticket(r)
}

// Ticket reads one factory ticket.
func (s *Store) Ticket(ctx context.Context, id work.TicketID) (work.FactoryTicket, error) {
	r, err := s.queries.GetTicket(ctx, int64(id))
	if err != nil {
		return work.FactoryTicket{}, queryError(fmt.Sprintf("read ticket %d", id), err)
	}
	return ticket(r)
}

// TicketsInState lists tickets in state.
func (s *Store) TicketsInState(ctx context.Context, state work.TicketState) ([]work.FactoryTicket, error) {
	rs, err := s.queries.ListTicketsByState(ctx, string(state))
	if err != nil {
		return nil, queryError(fmt.Sprintf("list tickets in %s", state), err)
	}
	return tickets(rs)
}

// SetTicketState moves a ticket to state.
func (s *Store) SetTicketState(ctx context.Context, id work.TicketID, state work.TicketState) (work.FactoryTicket, error) {
	r, err := s.queries.SetTicketState(ctx, sqlc.SetTicketStateParams{ID: int64(id), State: string(state)})
	if err != nil {
		return work.FactoryTicket{}, queryError(fmt.Sprintf("set ticket %d state", id), err)
	}
	return ticket(r)
}

// AddDependency makes blocker block blocked.
func (s *Store) AddDependency(ctx context.Context, blocker, blocked work.TicketID) error {
	return queryError(fmt.Sprintf("add dependency %d -> %d", blocker, blocked), s.queries.AddDependency(ctx, sqlc.AddDependencyParams{BlockerTicketID: int64(blocker), BlockedTicketID: int64(blocked)}))
}

// RemoveDependency removes the direct blocker relation.
func (s *Store) RemoveDependency(ctx context.Context, blocker, blocked work.TicketID) error {
	return queryError(fmt.Sprintf("remove dependency %d -> %d", blocker, blocked), s.queries.RemoveDependency(ctx, sqlc.RemoveDependencyParams{BlockerTicketID: int64(blocker), BlockedTicketID: int64(blocked)}))
}

// Blockers lists the tickets which must be done before id is ready.
func (s *Store) Blockers(ctx context.Context, id work.TicketID) ([]work.FactoryTicket, error) {
	rs, err := s.queries.ListTicketBlockers(ctx, int64(id))
	if err != nil {
		return nil, queryError(fmt.Sprintf("list blockers for ticket %d", id), err)
	}
	return tickets(rs)
}

// BlockedTickets lists the tickets directly blocked by id.
func (s *Store) BlockedTickets(ctx context.Context, id work.TicketID) ([]work.FactoryTicket, error) {
	rs, err := s.queries.ListTicketsBlockedBy(ctx, int64(id))
	if err != nil {
		return nil, queryError(fmt.Sprintf("list tickets blocked by %d", id), err)
	}
	return tickets(rs)
}

// ReadyTickets lists open tickets whose direct blockers are all done.
func (s *Store) ReadyTickets(ctx context.Context) ([]work.FactoryTicket, error) {
	rs, err := s.queries.ListReadyTickets(ctx)
	if err != nil {
		return nil, queryError("list ready tickets", err)
	}
	return tickets(rs)
}

// StartRun records a run that has begun.
func (s *Store) StartRun(ctx context.Context, id string, ticketID work.TicketID, startedAt time.Time) (work.RunRecord, error) {
	r, err := s.queries.StartRun(ctx, sqlc.StartRunParams{ID: uuid(id), TicketID: int64(ticketID), StartedAt: timestamp(startedAt)})
	if err != nil {
		return work.RunRecord{}, queryError(fmt.Sprintf("start run %s", id), err)
	}
	return run(r)
}

// EndRun records a run's terminal outcome.
func (s *Store) EndRun(ctx context.Context, id string, endedAt time.Time, outcome work.Outcome, failure work.FailureKind) (work.RunRecord, error) {
	r, err := s.queries.EndRun(ctx, sqlc.EndRunParams{ID: uuid(id), EndedAt: timestamp(endedAt), Outcome: text(string(outcome)), FailureKind: string(failure)})
	if err != nil {
		return work.RunRecord{}, queryError(fmt.Sprintf("end run %s", id), err)
	}
	return run(r)
}

// RecordStep records a stage turn before attempts begin.
func (s *Store) RecordStep(ctx context.Context, key work.StageKey) (work.StepRecord, error) {
	r, err := s.queries.RecordStep(ctx, sqlc.RecordStepParams{RunID: uuid(key.RunID), Stage: string(key.Stage), Turn: int32(key.Turn)})
	if err != nil {
		return work.StepRecord{}, queryError("record "+key.String(), err)
	}
	return step(r)
}

// StartAttempt records an attempt with unknown, unmeasured usage until it ends.
func (s *Store) StartAttempt(ctx context.Context, key work.AttemptKey, model work.Model, startedAt time.Time) (work.AttemptRecord, error) {
	r, err := s.queries.StartAttempt(ctx, sqlc.StartAttemptParams{RunID: uuid(key.RunID), Stage: string(key.Stage), Turn: int32(key.Turn), AttemptNo: int32(key.AttemptNo), Model: model.Name, Effort: model.Effort, StartedAt: timestamp(startedAt)})
	if err != nil {
		return work.AttemptRecord{}, queryError("start "+key.String(), err)
	}
	return attempt(r)
}

// EndAttempt atomically stores result, measured flag, and final usage.
func (s *Store) EndAttempt(ctx context.Context, key work.AttemptKey, endedAt time.Time, result work.AttemptResult, usage work.Usage, measured bool) (work.AttemptRecord, error) {
	r, err := s.queries.EndAttempt(ctx, sqlc.EndAttemptParams{RunID: uuid(key.RunID), Stage: string(key.Stage), Turn: int32(key.Turn), AttemptNo: int32(key.AttemptNo), EndedAt: timestamp(endedAt), Result: text(string(result)), InputTokens: usage.InputTokens, CachedInputTokens: usage.CachedInputTokens, OutputTokens: usage.OutputTokens, ReasoningTokens: usage.ReasoningTokens, Measured: measured})
	if err != nil {
		return work.AttemptRecord{}, queryError("end "+key.String(), err)
	}
	return attempt(r)
}

// PutTranscript upserts one attempt's compressed transcript.
func (s *Store) PutTranscript(ctx context.Context, value work.StoredTranscript) (work.StoredTranscript, error) {
	r, err := s.queries.UpsertTranscript(ctx, sqlc.UpsertTranscriptParams{RunID: uuid(value.Key.RunID), Stage: string(value.Key.Stage), Turn: int32(value.Key.Turn), AttemptNo: int32(value.Key.AttemptNo), CompressedBytes: value.CompressedBytes, Compression: value.Compression, UncompressedSizeBytes: value.UncompressedSizeBytes, Checksum: value.Checksum})
	if err != nil {
		return work.StoredTranscript{}, queryError("store transcript "+value.Key.String(), err)
	}
	return transcript(r)
}

// Transcript reads one attempt's transcript.
func (s *Store) Transcript(ctx context.Context, key work.AttemptKey) (work.StoredTranscript, error) {
	r, err := s.queries.GetTranscript(ctx, sqlc.GetTranscriptParams{RunID: uuid(key.RunID), Stage: string(key.Stage), Turn: int32(key.Turn), AttemptNo: int32(key.AttemptNo)})
	if err != nil {
		return work.StoredTranscript{}, queryError("read transcript "+key.String(), err)
	}
	return transcript(r)
}

// RunDetail reads a run and its steps and attempts for the console.
func (s *Store) RunDetail(ctx context.Context, id string) (work.RunDetail, error) {
	r, err := s.queries.GetRun(ctx, uuid(id))
	if err != nil {
		return work.RunDetail{}, queryError("read run "+id, err)
	}
	rr, err := run(r)
	if err != nil {
		return work.RunDetail{}, err
	}
	ss, err := s.queries.ListRunSteps(ctx, uuid(id))
	if err != nil {
		return work.RunDetail{}, queryError("list steps for run "+id, err)
	}
	as, err := s.queries.ListRunAttempts(ctx, uuid(id))
	if err != nil {
		return work.RunDetail{}, queryError("list attempts for run "+id, err)
	}
	d := work.RunDetail{Run: rr}
	for _, v := range ss {
		x, e := step(v)
		if e != nil {
			return d, e
		}
		d.Steps = append(d.Steps, x)
	}
	for _, v := range as {
		x, e := attempt(v)
		if e != nil {
			return d, e
		}
		d.Attempts = append(d.Attempts, x)
	}
	return d, nil
}

// DispatcherState reads the singleton dispatcher snapshot.
func (s *Store) DispatcherState(ctx context.Context) (work.DispatcherState, error) {
	r, err := s.queries.GetDispatcherState(ctx)
	if err != nil {
		return work.DispatcherState{}, queryError("read dispatcher state", err)
	}
	return dispatcher(r)
}

// SetDispatcherState replaces the singleton dispatcher snapshot.
func (s *Store) SetDispatcherState(ctx context.Context, value work.DispatcherState) (work.DispatcherState, error) {
	in, err := json.Marshal(value.InFlight)
	if err != nil {
		return work.DispatcherState{}, fmt.Errorf("encode dispatcher state: %w", err)
	}
	r, err := s.queries.SetDispatcherState(ctx, sqlc.SetDispatcherStateParams{Paused: value.Paused, MaxInFlight: int32(value.MaxInFlight), BreakerOpenUntil: timestamp(value.Breaker.OpenUntil), BreakerReason: text(value.Breaker.Reason), InFlight: in, NextTicketID: int8ptr(value.NextTicketID), WrittenAt: timestamp(value.WrittenAt)})
	if err != nil {
		return work.DispatcherState{}, queryError("write dispatcher state", err)
	}
	return dispatcher(r)
}

func queryError(operation string, err error) error {
	if err == nil {
		return nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && len(pgErr.Code) >= 2 && pgErr.Code[:2] == "23" {
		return fmt.Errorf("%s: %w: %w", operation, work.ErrPermanent, err)
	}
	return fmt.Errorf("%s: %w", operation, err)
}
func uuid(s string) pgtype.UUID { var u pgtype.UUID; _ = u.Scan(s); return u }
func timestamp(t time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: t, Valid: !t.IsZero()}
}
func text(s string) pgtype.Text { return pgtype.Text{String: s, Valid: s != ""} }
func int8ptr(id *work.TicketID) pgtype.Int8 {
	if id == nil {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: int64(*id), Valid: true}
}

func ticket(r sqlc.Ticket) (work.FactoryTicket, error) {
	state := work.TicketState(r.State)
	switch state {
	case work.TicketStateOpen, work.TicketStateWorking, work.TicketStateReview, work.TicketStateDone, work.TicketStateFailed:
	default:
		return work.FactoryTicket{}, fmt.Errorf("parse ticket %d state %q: %w", r.ID, r.State, work.ErrPermanent)
	}
	return work.FactoryTicket{ID: work.TicketID(r.ID), Title: r.Title, Body: r.Body, State: state, CreatedAt: r.CreatedAt.Time, UpdatedAt: r.UpdatedAt.Time}, nil
}

func tickets(rows []sqlc.Ticket) ([]work.FactoryTicket, error) {
	out := make([]work.FactoryTicket, 0, len(rows))
	for _, r := range rows {
		v, e := ticket(r)
		if e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, nil
}

func run(r sqlc.Run) (work.RunRecord, error) {
	id := r.ID.String()
	if !r.ID.Valid {
		return work.RunRecord{}, fmt.Errorf("parse run: invalid UUID: %w", work.ErrPermanent)
	}
	var ended *time.Time
	if r.EndedAt.Valid {
		x := r.EndedAt.Time
		ended = &x
	}
	var outcome *work.Outcome
	if r.Outcome.Valid {
		x := work.Outcome(r.Outcome.String)
		switch x {
		case work.OutcomeProposed, work.OutcomeBlocked, work.OutcomeExhausted, work.OutcomeFailed:
			outcome = &x
		default:
			return work.RunRecord{}, fmt.Errorf("parse run %s outcome %q: %w", id, x, work.ErrPermanent)
		}
	}
	failure := work.FailureKind(r.FailureKind)
	switch failure {
	case work.FailureNone, work.FailureAuth, work.FailureRateLimit, work.FailureOther:
	default:
		return work.RunRecord{}, fmt.Errorf("parse run %s failure kind %q: %w", id, failure, work.ErrPermanent)
	}
	return work.RunRecord{ID: id, TicketID: work.TicketID(r.TicketID), StartedAt: r.StartedAt.Time, EndedAt: ended, Outcome: outcome, FailureKind: failure}, nil
}

func stageKey(runID pgtype.UUID, stage string, turn int32) (work.StageKey, error) {
	if !runID.Valid {
		return work.StageKey{}, fmt.Errorf("parse step: invalid UUID: %w", work.ErrPermanent)
	}
	s := work.Stage(stage)
	switch s {
	case work.StagePlan, work.StageImplement, work.StageReview:
	default:
		return work.StageKey{}, fmt.Errorf("parse step %s stage %q: %w", runID.String(), stage, work.ErrPermanent)
	}
	return work.StageKey{RunID: runID.String(), Stage: s, Turn: int(turn)}, nil
}

func step(r sqlc.Step) (work.StepRecord, error) {
	k, e := stageKey(r.RunID, r.Stage, r.Turn)
	return work.StepRecord{Key: k}, e
}

func attempt(r sqlc.Attempt) (work.AttemptRecord, error) {
	k, e := stageKey(r.RunID, r.Stage, r.Turn)
	if e != nil {
		return work.AttemptRecord{}, e
	}
	var ended *time.Time
	if r.EndedAt.Valid {
		x := r.EndedAt.Time
		ended = &x
	}
	var result *work.AttemptResult
	if r.Result.Valid {
		x := work.AttemptResult(r.Result.String)
		switch x {
		case work.AttemptSucceeded, work.AttemptFailed:
			result = &x
		default:
			return work.AttemptRecord{}, fmt.Errorf("parse attempt %s result %q: %w", k.String(), x, work.ErrPermanent)
		}
	}
	return work.AttemptRecord{Key: work.AttemptKey{StageKey: k, AttemptNo: int(r.AttemptNo)}, Model: work.Model{Name: r.Model, Effort: r.Effort}, Usage: work.Usage{InputTokens: r.InputTokens, CachedInputTokens: r.CachedInputTokens, OutputTokens: r.OutputTokens, ReasoningTokens: r.ReasoningTokens}, Measured: r.Measured, StartedAt: r.StartedAt.Time, EndedAt: ended, Result: result}, nil
}

func transcript(r sqlc.Transcript) (work.StoredTranscript, error) {
	k, e := stageKey(r.RunID, r.Stage, r.Turn)
	if e != nil {
		return work.StoredTranscript{}, e
	}
	return work.StoredTranscript{Key: work.AttemptKey{StageKey: k, AttemptNo: int(r.AttemptNo)}, CompressedBytes: append([]byte(nil), r.CompressedBytes...), Compression: r.Compression, UncompressedSizeBytes: r.UncompressedSizeBytes, Checksum: append([]byte(nil), r.Checksum...)}, nil
}

func dispatcher(r sqlc.DispatcherState) (work.DispatcherState, error) {
	var in []work.InFlightTicket
	if err := json.Unmarshal(r.InFlight, &in); err != nil {
		return work.DispatcherState{}, fmt.Errorf("parse dispatcher state in flight: %w", err)
	}
	var next *work.TicketID
	if r.NextTicketID.Valid {
		x := work.TicketID(r.NextTicketID.Int64)
		next = &x
	}
	return work.DispatcherState{Paused: r.Paused, MaxInFlight: int(r.MaxInFlight), Breaker: work.Breaker{OpenUntil: r.BreakerOpenUntil.Time, Reason: r.BreakerReason.String}, InFlight: in, NextTicketID: next, WrittenAt: r.WrittenAt.Time}, nil
}
