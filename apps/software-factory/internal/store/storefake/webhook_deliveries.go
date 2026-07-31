package storefake

import (
	"context"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
)

// RecordWebhookDeliveryAndTransition mirrors the real store's single
// transaction in memory: recording deliveryID and applying the Ticket
// transition happen under the same lock, so a test sees the same
// all-or-nothing behaviour the real Postgres transaction gives.
func (f *Store) RecordWebhookDeliveryAndTransition(_ context.Context, deliveryID string, id store.TicketID, from, to store.TicketState) (store.WebhookDeliveryOutcome, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.webhookDeliveries == nil {
		f.webhookDeliveries = make(map[string]bool)
	}
	if f.webhookDeliveries[deliveryID] {
		return store.WebhookDeliveryDuplicate, nil
	}
	f.webhookDeliveries[deliveryID] = true

	ticket, ok := f.tickets[id]
	if !ok || ticket.State != from {
		return store.WebhookDeliveryStale, nil
	}
	ticket.State = to
	ticket.UpdatedAt = f.clk.Now()
	f.tickets[id] = ticket
	return store.WebhookDeliveryApplied, nil
}
