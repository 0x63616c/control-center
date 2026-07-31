// Package storefake is an in-memory implementation of internal/store's
// narrow interfaces, for tests that need a store without a database.
//
// It exists so every consumer this project builds on top of internal/store —
// activities, the API, the dispatcher — can be tested under
// SoftwareStyle's floor, *no unit test touches the real world*, without
// standing up Postgres. It reproduces the schema's invariants (state
// transitions the check constraints allow, the direct-dependency ready(T)
// definition) in memory, not just its method signatures — a fake that only
// matched the interface and not the behaviour would let a caller's tests
// pass against a lie.
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

	webhookDeliveries map[string]bool
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

// New returns an empty Store, seeded the way a freshly migrated database is:
// no tickets, no runs, no steps.
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
	return f
}

// CreateTicket files a new Ticket with all of its declared blockers. It does
// not publish the Ticket until every edge has been validated, matching the
// real store's transaction boundary.
func (f *Store) CreateTicket(_ context.Context, title, body string, blockers []store.TicketID) (store.Ticket, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := store.TicketID(f.nextTicketID)
	for _, blocker := range blockers {
		if _, ok := f.tickets[blocker]; !ok {
			return store.Ticket{}, fmt.Errorf("creating ticket %d with blocker %d: %w", id, blocker, store.ErrNotFound)
		}
		if path := f.ticketDependencyPathLocked(id, blocker); len(path) > 0 {
			return store.Ticket{}, fmt.Errorf("creating ticket %d with blocker %d: dependency would create cycle", id, blocker)
		}
	}
	now := f.clk.Now()
	t := store.Ticket{ID: id, Title: title, Body: body, State: store.TicketOpen, CreatedAt: now, UpdatedAt: now}
	f.tickets[id] = t
	for _, blocker := range blockers {
		if f.edges[blocker] == nil {
			f.edges[blocker] = make(map[store.TicketID]bool)
		}
		f.edges[blocker][id] = true
	}
	f.nextTicketID++
	return t, nil
}

// Ticket reads one Ticket by id.
func (f *Store) Ticket(_ context.Context, id store.TicketID) (store.Ticket, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	t, ok := f.tickets[id]
	if !ok {
		return store.Ticket{}, fmt.Errorf("ticket %d: %w", id, store.ErrNotFound)
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

// Tickets lists every Ticket, ordered by id.
func (f *Store) Tickets(_ context.Context) ([]store.Ticket, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]store.Ticket, 0, len(f.tickets))
	for _, ticket := range f.tickets {
		out = append(out, ticket)
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

// TransitionTicketState atomically moves a Ticket only from the expected state.
func (f *Store) TransitionTicketState(_ context.Context, id store.TicketID, from, to store.TicketState) (store.Ticket, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ticket, ok := f.tickets[id]
	if !ok || ticket.State != from {
		return store.Ticket{}, fmt.Errorf("ticket %d: %w", id, store.ErrNotFound)
	}
	ticket.State = to
	ticket.UpdatedAt = f.clk.Now()
	f.tickets[id] = ticket
	return ticket, nil
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

// AddTicketDependencyIfAcyclic atomically mirrors the PostgreSQL graph write.
func (f *Store) AddTicketDependencyIfAcyclic(_ context.Context, blocker, blocked store.TicketID) ([]store.TicketID, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if path := f.ticketDependencyPathLocked(blocked, blocker); len(path) > 0 {
		return path, nil
	}
	if f.edges[blocker] == nil {
		f.edges[blocker] = make(map[store.TicketID]bool)
	}
	f.edges[blocker][blocked] = true
	return nil, nil
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

// TicketDependencyPath returns the existing blocker-to-blocked path from
// from to to, or nil when the graph has none.
func (f *Store) TicketDependencyPath(_ context.Context, from, to store.TicketID) ([]store.TicketID, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.ticketDependencyPathLocked(from, to), nil
}

func (f *Store) ticketDependencyPathLocked(from, to store.TicketID) []store.TicketID {
	queue := [][]store.TicketID{{from}}
	seen := map[store.TicketID]bool{from: true}
	for len(queue) > 0 {
		path := queue[0]
		queue = queue[1:]
		last := path[len(path)-1]
		if last == to {
			return path
		}
		for next := range f.edges[last] {
			if !seen[next] {
				seen[next] = true
				queue = append(queue, append(append([]store.TicketID(nil), path...), next))
			}
		}
	}
	return nil
}

func sortTickets(tickets []store.Ticket) {
	sort.Slice(tickets, func(i, j int) bool { return tickets[i].ID < tickets[j].ID })
}

// errNotFound reports that no row matched the request, the fake's analogue of
// the real store's pgx.ErrNoRows. It is store.ErrNotFound itself, not a
// look-alike: a caller (the API's ticketStoreError, for one) matches on that
// sentinel with errors.Is, and a fake that raised a different error here
// would pass its own tests while lying to every caller that runs against a
// real database.
var errNotFound = store.ErrNotFound

// notFoundf wraps errNotFound with context, the fake's equivalent of the real
// store's per-query %w wrapping.
func notFoundf(format string, args ...any) error {
	return fmt.Errorf(format+": %w", append(args, errNotFound)...)
}
