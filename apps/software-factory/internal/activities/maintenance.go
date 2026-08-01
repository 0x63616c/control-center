package activities

import (
	"context"
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
)

// TargetMaintenanceStore is the narrow persistent ownership view the
// scheduled maintainer needs. It deliberately does not expose Run rows: an
// active Ticket already contains the one Run ID whose ownership may be
// conditionally released.
type TargetMaintenanceStore interface {
	TicketsByState(context.Context, store.TicketState) ([]store.Ticket, error)
	ReconcileAbandonedRun(context.Context, string, store.TicketID) (bool, error)
}

// TargetMaintenanceActivities exposes the Store side of recovery. Temporal
// execution liveness and Run Worker deletion remain independent activities so
// the workflow makes the ordering and failure policy explicit.
type TargetMaintenanceActivities struct{ store TargetMaintenanceStore }

// NewTargetMaintenanceActivities constructs the Store adapter for one
// maintenance workflow execution.
func NewTargetMaintenanceActivities(store TargetMaintenanceStore) (*TargetMaintenanceActivities, error) {
	if store == nil {
		return nil, fmt.Errorf("target maintenance activities: a store is required")
	}
	return &TargetMaintenanceActivities{store: store}, nil
}

// ListActiveTargetRunOwners returns the only ownership pairs maintenance may
// repair, ordered by Ticket ID as TicketsByState guarantees.
func (a *TargetMaintenanceActivities) ListActiveTargetRunOwners(ctx context.Context) ([]store.ActiveTargetRunOwner, error) {
	tickets, err := a.store.TicketsByState(ctx, store.TicketActive)
	if err != nil {
		return nil, fail(ctx, "listing active target ticket owners", err)
	}
	owners := make([]store.ActiveTargetRunOwner, 0, len(tickets))
	for _, ticket := range tickets {
		if ticket.ActiveRunID == "" {
			return nil, fail(ctx, fmt.Sprintf("reading active ticket %d", ticket.ID), fmt.Errorf("active target ticket has no Run owner"))
		}
		owners = append(owners, store.ActiveTargetRunOwner{TicketID: ticket.ID, RunID: ticket.ActiveRunID})
	}
	return owners, nil
}

// ReconcileAbandonedTargetRun conditionally releases the exact active owner.
// A false result is the idempotent stale-race outcome: a live finalizer or
// replacement Run changed ownership first, so maintenance leaves it alone.
func (a *TargetMaintenanceActivities) ReconcileAbandonedTargetRun(ctx context.Context, runID string, ticketID store.TicketID) (bool, error) {
	reopened, err := a.store.ReconcileAbandonedRun(ctx, runID, ticketID)
	if err != nil {
		return false, fail(ctx, fmt.Sprintf("reconciling abandoned target run %s", runID), err)
	}
	return reopened, nil
}
