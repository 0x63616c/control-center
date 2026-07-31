package activities

import (
	"context"
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
)

// TicketActivities is the narrow Postgres activity set used only by the
// Ticket-backed workflows. Keeping it separate prevents the GitHub workflow
// from acquiring a dependency on factory Ticket rows.
type TicketActivities struct {
	store interface {
		store.ReadyTicketLister
		store.TicketReader
		store.TicketStateWriter
		store.DispatcherStateWriter
	}
}

// NewTicketActivities constructs TicketActivities over the factory store.
func NewTicketActivities(s interface {
	store.ReadyTicketLister
	store.TicketReader
	store.TicketStateWriter
	store.DispatcherStateWriter
}) (*TicketActivities, error) {
	if s == nil {
		return nil, fmt.Errorf("ticket activities: a store is required")
	}
	return &TicketActivities{store: s}, nil
}

// ListReadyTickets lists only Tickets whose direct dependencies are done.
func (a *TicketActivities) ListReadyTickets(ctx context.Context) ([]store.Ticket, error) {
	tickets, err := a.store.ReadyTickets(ctx)
	if err != nil {
		return nil, fail(ctx, "listing ready factory tickets", err)
	}
	return tickets, nil
}

// ReadTicket reads title and body for a Ticket-backed run.
func (a *TicketActivities) ReadTicket(ctx context.Context, id store.TicketID) (store.Ticket, error) {
	ticket, err := a.store.Ticket(ctx, id)
	if err != nil {
		return store.Ticket{}, fail(ctx, fmt.Sprintf("reading factory ticket %d", id), err)
	}
	return ticket, nil
}

// TransitionTicketState applies an owned lifecycle transition atomically.
func (a *TicketActivities) TransitionTicketState(ctx context.Context, id store.TicketID, from, to store.TicketState) (store.Ticket, error) {
	ticket, err := a.store.TransitionTicketState(ctx, id, from, to)
	if err != nil {
		return store.Ticket{}, fail(ctx, fmt.Sprintf("moving factory ticket %d from %s to %s", id, from, to), err)
	}
	return ticket, nil
}

// PutFactoryDispatcherState records the Ticket dispatcher's projection.
func (a *TicketActivities) PutFactoryDispatcherState(ctx context.Context, state store.DispatcherState) error {
	if err := a.store.PutDispatcherState(ctx, state); err != nil {
		return fail(ctx, "writing factory dispatcher state", err)
	}
	return nil
}
