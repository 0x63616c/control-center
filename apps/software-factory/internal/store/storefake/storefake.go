// Package storefake is an in-memory implementation of internal/store's
// narrow interfaces, for tests that need a store without a database.
//
// It exists so every consumer this project builds on top of internal/store —
// activities, the API, the dispatcher — can be tested under
// SoftwareStyle's floor, *no unit test touches the real world*, without
// standing up Postgres. It reproduces the schema's invariants (state
// transitions the check constraints allow, the direct-dependency ready(T)
// definition, the single dispatcher_state row) in memory, not just its
// method signatures — a fake that only matched the interface and not the
// behaviour would let a caller's tests pass against a lie.
package storefake

import (
	"context"
	"fmt"
	"sort"
	"sync"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// Store is the in-memory store. The zero value is not usable; construct one
// with New.
type Store struct {
	mu  sync.Mutex
	clk clock.Clock

	nextTicketID int64
	tickets      map[store.TicketID]store.Ticket
	edges        map[store.TicketID]map[store.TicketID]bool // blocker -> blocked

	runs map[string]store.Run

	// steps and attempts are keyed by the identity their row carries: a Step
	// has no Ticket, so its key never does either.
	steps    map[stepKey]bool
	attempts map[attemptKey]store.Attempt

	transcripts map[attemptKey]store.Transcript

	dispatcherState     store.DispatcherState
	dispatcherStateSeen bool
}

// Option configures a Store built by New.
type Option func(*Store)

// WithClock replaces the clock CreateTicket and UpdateTicketState stamp rows
// with — clocktest.NewFake, for a test that asserts on a specific CreatedAt or
// UpdatedAt. The default is the real clock, which is fine for every test that
// only asserts relative ordering.
func WithClock(clk clock.Clock) Option {
	return func(f *Store) { f.clk = clk }
}

type stepKey struct {
	runID string
	stage work.Stage
	turn  int
}

type attemptKey struct {
	stepKey
	attemptNo int
}

// defaultMaxInFlight mirrors the seed row migration 00002 inserts, so a fake
// store starts in the same state a freshly migrated database does rather than
// with no dispatcher_state row at all.
const defaultMaxInFlight = 3

// New returns an empty Store, seeded the way a freshly migrated database is:
// no tickets, and one dispatcher_state row at its migration defaults.
func New(opts ...Option) *Store {
	f := &Store{
		clk:          clock.System{},
		nextTicketID: 1,
		tickets:      make(map[store.TicketID]store.Ticket),
		edges:        make(map[store.TicketID]map[store.TicketID]bool),
		runs:         make(map[string]store.Run),
		steps:        make(map[stepKey]bool),
		attempts:     make(map[attemptKey]store.Attempt),
		transcripts:  make(map[attemptKey]store.Transcript),
	}
	for _, opt := range opts {
		opt(f)
	}
	f.dispatcherState = store.DispatcherState{MaxInFlight: defaultMaxInFlight, WrittenAt: f.clk.Now()}
	f.dispatcherStateSeen = true
	return f
}

// CreateTicket files a new Ticket in store.TicketOpen.
func (f *Store) CreateTicket(_ context.Context, title, body string) (store.Ticket, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := store.TicketID(f.nextTicketID)
	f.nextTicketID++
	now := f.clk.Now()
	t := store.Ticket{ID: id, Title: title, Body: body, State: store.TicketOpen, CreatedAt: now, UpdatedAt: now}
	f.tickets[id] = t
	return t, nil
}

// Ticket reads one Ticket by id.
func (f *Store) Ticket(_ context.Context, id store.TicketID) (store.Ticket, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	t, ok := f.tickets[id]
	if !ok {
		return store.Ticket{}, fmt.Errorf("ticket %d: %w", id, errNotFound)
	}
	return t, nil
}

// TicketsByState lists every Ticket in state, ordered by id.
func (f *Store) TicketsByState(_ context.Context, state store.TicketState) ([]store.Ticket, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []store.Ticket
	for _, t := range f.tickets {
		if t.State == state {
			out = append(out, t)
		}
	}
	sortTickets(out)
	return out, nil
}

// UpdateTicketState moves ticket id to state.
func (f *Store) UpdateTicketState(_ context.Context, id store.TicketID, state store.TicketState) (store.Ticket, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	t, ok := f.tickets[id]
	if !ok {
		return store.Ticket{}, fmt.Errorf("ticket %d: %w", id, errNotFound)
	}
	t.State = state
	t.UpdatedAt = f.clk.Now()
	f.tickets[id] = t
	return t, nil
}

// ReadyTickets lists every open Ticket whose direct dependencies are all
// done, exactly ADR-0012's ready(T) — mirroring the real store's ReadyTickets
// query rather than the schema it runs against.
func (f *Store) ReadyTickets(_ context.Context) ([]store.Ticket, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []store.Ticket
	for id, t := range f.tickets {
		if t.State != store.TicketOpen {
			continue
		}
		if f.everyBlockerDoneLocked(id) {
			out = append(out, t)
		}
	}
	sortTickets(out)
	return out, nil
}

func (f *Store) everyBlockerDoneLocked(blocked store.TicketID) bool {
	for blocker, blockedSet := range f.edges {
		if !blockedSet[blocked] {
			continue
		}
		if f.tickets[blocker].State != store.TicketDone {
			return false
		}
	}
	return true
}

// AddTicketDependency records that blocker must be done before blocked is
// ready.
func (f *Store) AddTicketDependency(_ context.Context, blocker, blocked store.TicketID) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.edges[blocker] == nil {
		f.edges[blocker] = make(map[store.TicketID]bool)
	}
	f.edges[blocker][blocked] = true
	return nil
}

// RemoveTicketDependency removes a previously recorded dependency edge.
func (f *Store) RemoveTicketDependency(_ context.Context, blocker, blocked store.TicketID) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.edges[blocker], blocked)
	return nil
}

// TicketBlockers lists every ticket that blocks ticket.
func (f *Store) TicketBlockers(_ context.Context, ticket store.TicketID) ([]store.Ticket, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []store.Ticket
	for blocker, blockedSet := range f.edges {
		if blockedSet[ticket] {
			out = append(out, f.tickets[blocker])
		}
	}
	sortTickets(out)
	return out, nil
}

// TicketBlocks lists every ticket that ticket blocks.
func (f *Store) TicketBlocks(_ context.Context, ticket store.TicketID) ([]store.Ticket, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []store.Ticket
	for blocked := range f.edges[ticket] {
		out = append(out, f.tickets[blocked])
	}
	sortTickets(out)
	return out, nil
}

func sortTickets(tickets []store.Ticket) {
	sort.Slice(tickets, func(i, j int) bool { return tickets[i].ID < tickets[j].ID })
}

// errNotFound reports that no row matched the request, the fake's analogue of
// the real store's pgx.ErrNoRows.
var errNotFound = fmt.Errorf("not found")

// notFoundf wraps errNotFound with context, the fake's equivalent of the real
// store's per-query %w wrapping.
func notFoundf(format string, args ...any) error {
	return fmt.Errorf(format+": %w", append(args, errNotFound)...)
}
