// Package storefake provides an in-memory record store for consumer tests.
package storefake

import (
	"context"
	"fmt"
	"sync"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// Store is a mutex-protected in-memory factory record store.
type Store struct {
	mu          sync.Mutex
	next        work.TicketID
	tickets     map[work.TicketID]work.FactoryTicket
	edges       map[work.TicketID]map[work.TicketID]bool
	transcripts map[work.AttemptKey]work.StoredTranscript
	state       work.DispatcherState
}

// New returns an empty fake store with the factory dispatcher defaults.
func New() *Store {
	return &Store{tickets: map[work.TicketID]work.FactoryTicket{}, edges: map[work.TicketID]map[work.TicketID]bool{}, transcripts: map[work.AttemptKey]work.StoredTranscript{}, state: work.DispatcherState{MaxInFlight: 3}}
}

// CreateTicket records a new open ticket.
func (s *Store) CreateTicket(_ context.Context, title, body string) (work.FactoryTicket, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.next++
	v := work.FactoryTicket{ID: s.next, Title: title, Body: body, State: work.TicketStateOpen}
	s.tickets[v.ID] = v
	return v, nil
}

// Ticket reads one ticket.
func (s *Store) Ticket(_ context.Context, id work.TicketID) (work.FactoryTicket, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.tickets[id]
	if !ok {
		return work.FactoryTicket{}, fmt.Errorf("read ticket %d: not found", id)
	}
	return v, nil
}

// SetTicketState changes a ticket state.
func (s *Store) SetTicketState(_ context.Context, id work.TicketID, state work.TicketState) (work.FactoryTicket, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.tickets[id]
	if !ok {
		return work.FactoryTicket{}, fmt.Errorf("set ticket %d state: not found", id)
	}
	v.State = state
	s.tickets[id] = v
	return v, nil
}

// AddDependency adds blocker -> blocked.
func (s *Store) AddDependency(_ context.Context, blocker, blocked work.TicketID) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.edges[blocked] == nil {
		s.edges[blocked] = map[work.TicketID]bool{}
	}
	s.edges[blocked][blocker] = true
	return nil
}

// RemoveDependency removes blocker -> blocked.
func (s *Store) RemoveDependency(_ context.Context, blocker, blocked work.TicketID) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.edges[blocked], blocker)
	return nil
}

// ReadyTickets lists open tickets whose direct blockers are done.
func (s *Store) ReadyTickets(_ context.Context) ([]work.FactoryTicket, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]work.FactoryTicket, 0)
	for id, v := range s.tickets {
		if v.State != work.TicketStateOpen {
			continue
		}
		ready := true
		for blocker := range s.edges[id] {
			if s.tickets[blocker].State != work.TicketStateDone {
				ready = false
				break
			}
		}
		if ready {
			out = append(out, v)
		}
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].ID < out[j-1].ID; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out, nil
}

// PutTranscript stores a defensive copy of an attempt transcript.
func (s *Store) PutTranscript(_ context.Context, v work.StoredTranscript) (work.StoredTranscript, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v.CompressedBytes = append([]byte(nil), v.CompressedBytes...)
	v.Checksum = append([]byte(nil), v.Checksum...)
	s.transcripts[v.Key] = v
	return v, nil
}

// Transcript reads a defensive copy of one transcript.
func (s *Store) Transcript(_ context.Context, key work.AttemptKey) (work.StoredTranscript, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.transcripts[key]
	if !ok {
		return work.StoredTranscript{}, fmt.Errorf("read transcript %s: not found", key.String())
	}
	v.CompressedBytes = append([]byte(nil), v.CompressedBytes...)
	v.Checksum = append([]byte(nil), v.Checksum...)
	return v, nil
}

// DispatcherState reads a copy of the singleton dispatcher state.
func (s *Store) DispatcherState(_ context.Context) (work.DispatcherState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return copyState(s.state), nil
}

// SetDispatcherState replaces the singleton dispatcher state.
func (s *Store) SetDispatcherState(_ context.Context, v work.DispatcherState) (work.DispatcherState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state = copyState(v)
	return copyState(s.state), nil
}

func copyState(v work.DispatcherState) work.DispatcherState {
	v.InFlight = append([]work.InFlightTicket(nil), v.InFlight...)
	if v.NextTicketID != nil {
		x := *v.NextTicketID
		v.NextTicketID = &x
	}
	return v
}
