package main

import (
	"context"
	"fmt"

	temporalapi "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/temporal"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
)

type legacyExecutionLister interface {
	List(context.Context) ([]temporalapi.LegacyExecution, error)
}

type legacyTicketLister interface {
	TicketsByState(context.Context, store.TicketState) ([]store.Ticket, error)
}

// ensureActivationReady is the code-side half of the operational cutover
// gate. It never mutates old work: activation simply refuses to publish an
// unpaused target policy while a legacy workflow or Ticket state remains.
func ensureActivationReady(ctx context.Context, executions legacyExecutionLister, tickets legacyTicketLister) error {
	legacyExecutions, err := executions.List(ctx)
	if err != nil {
		return fmt.Errorf("checking legacy workflow executions before activation: %w", err)
	}
	if len(legacyExecutions) != 0 {
		return fmt.Errorf("activation requires zero running legacy workflows; found %d", len(legacyExecutions))
	}
	for _, state := range []store.TicketState{store.TicketWorking, store.TicketReview} {
		legacyTickets, err := tickets.TicketsByState(ctx, state)
		if err != nil {
			return fmt.Errorf("checking legacy %s Tickets before activation: %w", state, err)
		}
		if len(legacyTickets) != 0 {
			return fmt.Errorf("activation requires zero legacy %s Tickets; found %d", state, len(legacyTickets))
		}
	}
	return nil
}
