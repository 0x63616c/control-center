package store

import (
	"context"
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store/storedb"
)

// TicketDependencyWriter records and removes one dependency edge.
//
// Cycle rejection is not this interface's job: ADR-0012 assigns it to the API
// ticket that creates edges, as application logic that runs before a write
// reaches here.
type TicketDependencyWriter interface {
	AddTicketDependency(ctx context.Context, blocker, blocked TicketID) error
	RemoveTicketDependency(ctx context.Context, blocker, blocked TicketID) error
}

// TicketDependencyReader reads one ticket's blockers and what it blocks — the
// two directions ADR-0012's one `blocks`/`blocked_by` relation is read in.
type TicketDependencyReader interface {
	TicketBlockers(ctx context.Context, ticket TicketID) ([]Ticket, error)
	TicketBlocks(ctx context.Context, ticket TicketID) ([]Ticket, error)
}

// AddTicketDependency records that blocker must be done before blocked is
// ready.
func (s *Store) AddTicketDependency(ctx context.Context, blocker, blocked TicketID) error {
	err := s.q.AddTicketDependency(ctx, storedb.AddTicketDependencyParams{
		BlockerTicketID: int64(blocker),
		BlockedTicketID: int64(blocked),
	})
	if err != nil {
		return fmt.Errorf("adding dependency: ticket %d blocks ticket %d: %w", blocker, blocked, wrapQueryErr(err))
	}
	return nil
}

// RemoveTicketDependency removes a previously recorded dependency edge.
func (s *Store) RemoveTicketDependency(ctx context.Context, blocker, blocked TicketID) error {
	err := s.q.RemoveTicketDependency(ctx, storedb.RemoveTicketDependencyParams{
		BlockerTicketID: int64(blocker),
		BlockedTicketID: int64(blocked),
	})
	if err != nil {
		return fmt.Errorf("removing dependency: ticket %d blocks ticket %d: %w", blocker, blocked, wrapQueryErr(err))
	}
	return nil
}

// TicketBlockers lists every ticket that blocks ticket.
func (s *Store) TicketBlockers(ctx context.Context, ticket TicketID) ([]Ticket, error) {
	rows, err := s.q.TicketBlockers(ctx, int64(ticket))
	if err != nil {
		return nil, fmt.Errorf("reading blockers of ticket %d: %w", ticket, wrapQueryErr(err))
	}
	return ticketsFromRows(rows)
}

// TicketBlocks lists every ticket that ticket blocks.
func (s *Store) TicketBlocks(ctx context.Context, ticket TicketID) ([]Ticket, error) {
	rows, err := s.q.TicketBlocks(ctx, int64(ticket))
	if err != nil {
		return nil, fmt.Errorf("reading tickets blocked by ticket %d: %w", ticket, wrapQueryErr(err))
	}
	return ticketsFromRows(rows)
}

var (
	_ TicketDependencyWriter = (*Store)(nil)
	_ TicketDependencyReader = (*Store)(nil)
)
