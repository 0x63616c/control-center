package store_test

import (
	"context"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
)

// TestRecordWebhookDeliveryAndTransitionAppliesOnceAndUnblocksDownstream
// proves the whole point of #557: a merged pull request's delivery moves its
// Ticket to done, and that alone is what makes a downstream Ticket ready —
// the consequence, not just the state change (ADR-0012's ready(T)).
func TestRecordWebhookDeliveryAndTransitionAppliesOnceAndUnblocksDownstream(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	upstream, err := s.CreateTicket(ctx, "upstream", "merged first")
	if err != nil {
		t.Fatalf("CreateTicket(upstream): %v", err)
	}
	downstream, err := s.CreateTicket(ctx, "downstream", "needs upstream done")
	if err != nil {
		t.Fatalf("CreateTicket(downstream): %v", err)
	}
	if err := s.AddTicketDependency(ctx, upstream.ID, downstream.ID); err != nil {
		t.Fatalf("AddTicketDependency: %v", err)
	}
	if _, err := s.TransitionTicketState(ctx, upstream.ID, store.TicketOpen, store.TicketWorking); err != nil {
		t.Fatalf("TransitionTicketState(open->working): %v", err)
	}
	if _, err := s.TransitionTicketState(ctx, upstream.ID, store.TicketWorking, store.TicketReview); err != nil {
		t.Fatalf("TransitionTicketState(working->review): %v", err)
	}

	ready, err := s.ReadyTickets(ctx)
	if err != nil {
		t.Fatalf("ReadyTickets before merge: %v", err)
	}
	if containsTicket(ready, downstream.ID) {
		t.Fatalf("ReadyTickets() before merge = %+v, want downstream not yet ready", ready)
	}

	outcome, err := s.RecordWebhookDeliveryAndTransition(ctx, "delivery-1", upstream.ID, store.TicketReview, store.TicketDone)
	if err != nil {
		t.Fatalf("RecordWebhookDeliveryAndTransition: %v", err)
	}
	if outcome != store.WebhookDeliveryApplied {
		t.Fatalf("outcome = %v, want WebhookDeliveryApplied", outcome)
	}

	got, err := s.Ticket(ctx, upstream.ID)
	if err != nil {
		t.Fatalf("Ticket(upstream): %v", err)
	}
	if got.State != store.TicketDone {
		t.Fatalf("upstream state = %s, want done", got.State)
	}

	ready, err = s.ReadyTickets(ctx)
	if err != nil {
		t.Fatalf("ReadyTickets after merge: %v", err)
	}
	if !containsTicket(ready, downstream.ID) {
		t.Fatalf("ReadyTickets() after merge = %+v, want downstream ready as a consequence of upstream done", ready)
	}

	// Redelivery of the same delivery id is a no-op: GitHub's Redeliver
	// button and the relay's own retries must be safe.
	outcome, err = s.RecordWebhookDeliveryAndTransition(ctx, "delivery-1", upstream.ID, store.TicketReview, store.TicketDone)
	if err != nil {
		t.Fatalf("RecordWebhookDeliveryAndTransition (redelivery): %v", err)
	}
	if outcome != store.WebhookDeliveryDuplicate {
		t.Fatalf("redelivery outcome = %v, want WebhookDeliveryDuplicate", outcome)
	}
}

// TestRecordWebhookDeliveryAndTransitionRecordsDeliveryEvenWhenTheTicketMoved
// proves a new delivery id is recorded seen even when the Ticket is no longer
// in the expected `from` state — a human already moved it, or an earlier
// delivery already did — so a later, unrelated redelivery of the SAME id
// still cannot double-apply.
func TestRecordWebhookDeliveryAndTransitionRecordsDeliveryEvenWhenTheTicketMoved(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	ticket, err := s.CreateTicket(ctx, "solo", "no dependency")
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	// Never left TicketOpen, so it is not in TicketReview: this stands in for
	// a closed-without-merge delivery racing a human who already reopened
	// the ticket, or any other state the webhook did not expect.

	outcome, err := s.RecordWebhookDeliveryAndTransition(ctx, "delivery-stale", ticket.ID, store.TicketReview, store.TicketDone)
	if err != nil {
		t.Fatalf("RecordWebhookDeliveryAndTransition: %v", err)
	}
	if outcome != store.WebhookDeliveryStale {
		t.Fatalf("outcome = %v, want WebhookDeliveryStale", outcome)
	}

	got, err := s.Ticket(ctx, ticket.ID)
	if err != nil {
		t.Fatalf("Ticket: %v", err)
	}
	if got.State != store.TicketOpen {
		t.Fatalf("ticket state = %s, want unchanged open", got.State)
	}

	// The delivery id is still recorded seen: a later redelivery of this
	// exact id must still be a no-op, not a second attempt at the transition.
	outcome, err = s.RecordWebhookDeliveryAndTransition(ctx, "delivery-stale", ticket.ID, store.TicketReview, store.TicketDone)
	if err != nil {
		t.Fatalf("RecordWebhookDeliveryAndTransition (redelivery of stale): %v", err)
	}
	if outcome != store.WebhookDeliveryDuplicate {
		t.Fatalf("redelivery outcome = %v, want WebhookDeliveryDuplicate", outcome)
	}
}
