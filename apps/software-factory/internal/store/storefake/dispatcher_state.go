package storefake

import (
	"context"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
)

// DispatcherState reads what the dispatcher last wrote about itself.
func (f *Store) DispatcherState(_ context.Context) (store.DispatcherState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.dispatcherStateSeen {
		return store.DispatcherState{}, notFoundf("dispatcher state")
	}
	state := f.dispatcherState
	state.InFlight = append([]store.InFlightTicket(nil), f.dispatcherState.InFlight...)
	return state, nil
}

// PutDispatcherState overwrites the single dispatcher_state row with state.
func (f *Store) PutDispatcherState(_ context.Context, state store.DispatcherState) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	state.InFlight = append([]store.InFlightTicket(nil), state.InFlight...)
	f.dispatcherState = state
	f.dispatcherStateSeen = true
	return nil
}
