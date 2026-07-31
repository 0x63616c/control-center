package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store/storedb"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// DispatcherStateReader reads the single dispatcher_state row.
type DispatcherStateReader interface {
	DispatcherState(ctx context.Context) (DispatcherState, error)
}

// DispatcherStateWriter writes the single dispatcher_state row, once per tick.
type DispatcherStateWriter interface {
	PutDispatcherState(ctx context.Context, state DispatcherState) error
}

// DispatcherState reads what the dispatcher last wrote about itself.
func (s *Store) DispatcherState(ctx context.Context) (DispatcherState, error) {
	row, err := s.q.DispatcherState(ctx)
	if err != nil {
		return DispatcherState{}, fmt.Errorf("reading dispatcher state: %w", wrapQueryErr(err))
	}
	var inFlight []InFlightTicket
	if len(row.InFlight) > 0 {
		if err := json.Unmarshal(row.InFlight, &inFlight); err != nil {
			return DispatcherState{}, fmt.Errorf("reading dispatcher state: decoding in_flight: %w", err)
		}
	}
	return DispatcherState{
		Paused:      row.Paused,
		MaxInFlight: int(row.MaxInFlight),
		Breaker: work.Breaker{
			OpenUntil: timeFromPg(row.BreakerOpenUntil),
			Reason:    textFromPg(row.BreakerReason),
		},
		InFlight:     inFlight,
		NextTicketID: ticketIDFromPg(row.NextTicketID),
		WrittenAt:    timeFromPg(row.WrittenAt),
	}, nil
}

// PutDispatcherState overwrites the single dispatcher_state row with state.
// The dispatcher calls this once per tick, per ADR-0012 — it is the write
// that finally makes "what is it going to work on next" answerable.
func (s *Store) PutDispatcherState(ctx context.Context, state DispatcherState) error {
	// in_flight's CHECK constraint requires a JSON array, never JSON null, so a
	// nil slice must still encode as "[]" rather than json.Marshal's default.
	inFlight := []byte("[]")
	if len(state.InFlight) > 0 {
		encoded, err := json.Marshal(state.InFlight)
		if err != nil {
			return fmt.Errorf("writing dispatcher state: encoding in_flight: %w", err)
		}
		inFlight = encoded
	}
	err := s.q.PutDispatcherState(ctx, storedb.PutDispatcherStateParams{
		Paused:           state.Paused,
		MaxInFlight:      int32(state.MaxInFlight),
		BreakerOpenUntil: pgOptionalTimestamp(state.Breaker.OpenUntil),
		BreakerReason:    pgOptionalText(state.Breaker.Reason),
		InFlight:         inFlight,
		NextTicketID:     pgOptionalTicketID(state.NextTicketID),
		WrittenAt:        pgTimestamp(state.WrittenAt),
	})
	if err != nil {
		return fmt.Errorf("writing dispatcher state: %w", wrapQueryErr(err))
	}
	return nil
}

var (
	_ DispatcherStateReader = (*Store)(nil)
	_ DispatcherStateWriter = (*Store)(nil)
)
