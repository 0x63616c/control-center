package main

import (
	"context"
	"testing"

	temporalapi "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/temporal"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
)

type fakeLegacyExecutions struct{ listed []temporalapi.LegacyExecution }

func (f fakeLegacyExecutions) List(context.Context) ([]temporalapi.LegacyExecution, error) {
	return f.listed, nil
}

type fakeLegacyTickets struct{ byState map[string][]store.Ticket }

func (f fakeLegacyTickets) TicketsByState(_ context.Context, state store.TicketState) ([]store.Ticket, error) {
	return f.byState[state.String()], nil
}

func TestActivationReadinessAcceptsOnlyAQuiescentLegacyBoundary(t *testing.T) {
	t.Parallel()
	if err := ensureActivationReady(context.Background(), fakeLegacyExecutions{}, fakeLegacyTickets{}); err != nil {
		t.Fatalf("ensureActivationReady: %v", err)
	}
}

func TestActivationReadinessRejectsRunningLegacyWorkflow(t *testing.T) {
	t.Parallel()
	err := ensureActivationReady(context.Background(), fakeLegacyExecutions{listed: []temporalapi.LegacyExecution{{ID: "legacy"}}}, fakeLegacyTickets{})
	if err == nil {
		t.Fatal("ensureActivationReady accepted a running legacy workflow")
	}
}

func TestActivationReadinessRejectsEachLegacyTicketState(t *testing.T) {
	t.Parallel()
	for _, state := range []store.TicketState{store.TicketWorking, store.TicketReview} {
		state := state
		t.Run(state.String(), func(t *testing.T) {
			t.Parallel()
			err := ensureActivationReady(context.Background(), fakeLegacyExecutions{}, fakeLegacyTickets{byState: map[string][]store.Ticket{
				state.String(): {{ID: 1, State: state}},
			}})
			if err == nil {
				t.Fatalf("ensureActivationReady accepted %s Ticket", state)
			}
		})
	}
}
