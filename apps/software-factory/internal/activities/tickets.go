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
		store.TicketStateWriter
	}
}

// NewTicketActivities constructs TicketActivities over the factory store.
func NewTicketActivities(s interface {
	store.ReadyTicketLister
	store.TicketStateWriter
},
) (*TicketActivities, error) {
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

// TransitionTicketState applies an owned lifecycle transition atomically.
func (a *TicketActivities) TransitionTicketState(ctx context.Context, id store.TicketID, from, to store.TicketState) (store.Ticket, error) {
	ticket, err := a.store.TransitionTicketState(ctx, id, from, to)
	if err != nil {
		return store.Ticket{}, fail(ctx, fmt.Sprintf("moving factory ticket %d from %s to %s", id, from, to), err)
	}
	return ticket, nil
}
