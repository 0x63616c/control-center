package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store/storedb"
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
	var state DispatcherState
	for _, field := range []struct {
		name string
		raw  []byte
		into any
	}{
		{name: "config", raw: row.Config, into: &state.Config},
		{name: "tuning", raw: row.Tuning, into: &state.Tuning},
		{name: "breaker", raw: row.Breaker, into: &state.Breaker},
		{name: "in_flight", raw: row.InFlight, into: &state.InFlight},
		{name: "candidates", raw: row.Candidates, into: &state.Candidates},
	} {
		if err := json.Unmarshal(field.raw, field.into); err != nil {
			return DispatcherState{}, fmt.Errorf("reading dispatcher state: decoding %s: %w", field.name, err)
		}
	}
	state.ConfigError = row.ConfigError
	state.FreeSlots = int(row.FreeSlots)
	state.WrittenAt = timeFromPg(row.WrittenAt)
	return state, nil
}

// PutDispatcherState overwrites the single dispatcher_state row with state.
// The dispatcher calls this once per tick, per ADR-0012 — it is the write
// that finally makes "what is it going to work on next" answerable.
func (s *Store) PutDispatcherState(ctx context.Context, state DispatcherState) error {
	encode := func(name string, value any, array bool) ([]byte, error) {
		if array {
			switch name {
			case "in_flight":
				if len(state.InFlight) == 0 {
					return []byte("[]"), nil
				}
			case "candidates":
				if len(state.Candidates) == 0 {
					return []byte("[]"), nil
				}
			}
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, fmt.Errorf("writing dispatcher state: encoding %s: %w", name, err)
		}
		return encoded, nil
	}
	config, err := encode("config", state.Config, false)
	if err != nil {
		return err
	}
	tuning, err := encode("tuning", state.Tuning, false)
	if err != nil {
		return err
	}
	breaker, err := encode("breaker", state.Breaker, false)
	if err != nil {
		return err
	}
	inFlight, err := encode("in_flight", state.InFlight, true)
	if err != nil {
		return err
	}
	candidates, err := encode("candidates", state.Candidates, true)
	if err != nil {
		return err
	}
	err = s.q.PutDispatcherState(ctx, storedb.PutDispatcherStateParams{
		Config: config, Tuning: tuning, Breaker: breaker, ConfigError: state.ConfigError,
		InFlight: inFlight, Candidates: candidates, FreeSlots: int32(state.FreeSlots), WrittenAt: pgTimestamp(state.WrittenAt),
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
