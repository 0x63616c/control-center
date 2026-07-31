package store

import (
	"context"
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store/storedb"
)

// TicketCreator files a new Ticket. The API ticket that accepts a create
// request is this method's caller.
type TicketCreator interface {
	CreateTicket(ctx context.Context, title, body string) (Ticket, error)
}

// TicketReader reads one Ticket, or every Ticket in a state.
type TicketReader interface {
	Ticket(ctx context.Context, id TicketID) (Ticket, error)
	TicketsByState(ctx context.Context, state TicketState) ([]Ticket, error)
}

// TicketStateWriter moves a Ticket to a new state.
type TicketStateWriter interface {
	UpdateTicketState(ctx context.Context, id TicketID, state TicketState) (Ticket, error)
}

// ReadyTicketLister lists the Tickets the dispatcher may start next: open,
// with every dependency done. The dispatcher is this method's one caller.
type ReadyTicketLister interface {
	ReadyTickets(ctx context.Context) ([]Ticket, error)
}

// CreateTicket files a new Ticket in TicketOpen.
func (s *Store) CreateTicket(ctx context.Context, title, body string) (Ticket, error) {
	row, err := s.q.CreateTicket(ctx, storedb.CreateTicketParams{
		Title: title,
		Body:  body,
		State: string(TicketOpen),
	})
	if err != nil {
		return Ticket{}, fmt.Errorf("creating ticket %q: %w", title, wrapQueryErr(err))
	}
	return ticketFromRow(row)
}

// Ticket reads one Ticket by id.
func (s *Store) Ticket(ctx context.Context, id TicketID) (Ticket, error) {
	row, err := s.q.Ticket(ctx, int64(id))
	if err != nil {
		return Ticket{}, fmt.Errorf("reading ticket %d: %w", id, wrapQueryErr(err))
	}
	return ticketFromRow(row)
}

// TicketsByState lists every Ticket in state, ordered by id.
func (s *Store) TicketsByState(ctx context.Context, state TicketState) ([]Ticket, error) {
	rows, err := s.q.TicketsByState(ctx, string(state))
	if err != nil {
		return nil, fmt.Errorf("listing %s tickets: %w", state, wrapQueryErr(err))
	}
	return ticketsFromRows(rows)
}

// UpdateTicketState moves ticket id to state and returns the updated row.
func (s *Store) UpdateTicketState(ctx context.Context, id TicketID, state TicketState) (Ticket, error) {
	row, err := s.q.UpdateTicketState(ctx, storedb.UpdateTicketStateParams{
		ID:    int64(id),
		State: string(state),
	})
	if err != nil {
		return Ticket{}, fmt.Errorf("moving ticket %d to %s: %w", id, state, wrapQueryErr(err))
	}
	return ticketFromRow(row)
}

// ReadyTickets lists every open Ticket whose direct dependencies are all
// done — ADR-0012's ready(T) definition, and nothing more: it does not walk
// the graph transitively, because the ADR does not ask it to.
func (s *Store) ReadyTickets(ctx context.Context) ([]Ticket, error) {
	rows, err := s.q.ReadyTickets(ctx)
	if err != nil {
		return nil, fmt.Errorf("listing ready tickets: %w", wrapQueryErr(err))
	}
	return ticketsFromRows(rows)
}

// ticketFromRow parses a stored row into a Ticket, the one place a row's
// state string becomes a typed TicketState.
func ticketFromRow(row storedb.Ticket) (Ticket, error) {
	state := TicketState(row.State)
	if !state.Valid() {
		return Ticket{}, fmt.Errorf("ticket %d: stored state %q is not a known TicketState", row.ID, row.State)
	}
	return Ticket{
		ID:        TicketID(row.ID),
		Title:     row.Title,
		Body:      row.Body,
		State:     state,
		CreatedAt: timeFromPg(row.CreatedAt),
		UpdatedAt: timeFromPg(row.UpdatedAt),
	}, nil
}

func ticketsFromRows(rows []storedb.Ticket) ([]Ticket, error) {
	tickets := make([]Ticket, 0, len(rows))
	for _, row := range rows {
		t, err := ticketFromRow(row)
		if err != nil {
			return nil, err
		}
		tickets = append(tickets, t)
	}
	return tickets, nil
}

var (
	_ TicketCreator     = (*Store)(nil)
	_ TicketReader      = (*Store)(nil)
	_ TicketStateWriter = (*Store)(nil)
	_ ReadyTicketLister = (*Store)(nil)
)
