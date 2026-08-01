package activities_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"go.temporal.io/sdk/temporal"
)

type readyTicketStore struct {
	tickets []store.Ticket
	calls   int
}

func (s *readyTicketStore) ReadyTickets(context.Context) ([]store.Ticket, error) {
	s.calls++
	return s.tickets, nil
}

func TestAwaitDispatchableTicketsUsesRetryForExpectedNoWork(t *testing.T) {
	t.Parallel()

	backing := &readyTicketStore{}
	activities, err := activities.NewTicketActivities(backing)
	if err != nil {
		t.Fatalf("NewTicketActivities: %v", err)
	}

	_, err = activities.AwaitDispatchableTickets(context.Background())
	var application *temporal.ApplicationError
	if !errors.As(err, &application) {
		t.Fatalf("AwaitDispatchableTickets error = %T, want retryable ApplicationError: %v", err, err)
	}
	if application.Type() != activities.ErrTypeNoDispatchableTickets || application.NextRetryDelay() != 10*time.Second || application.NonRetryable() {
		t.Fatalf("no-work error = type %q, delay %s, non-retryable %t; want retryable 10s wait", application.Type(), application.NextRetryDelay(), application.NonRetryable())
	}
	if backing.calls != 1 {
		t.Fatalf("ReadyTickets calls = %d, want exactly one store read per activity try", backing.calls)
	}
}

func TestAwaitDispatchableTicketsReturnsTheReadyBatch(t *testing.T) {
	t.Parallel()

	want := []store.Ticket{{ID: 2, Title: "second"}, {ID: 9, Title: "ninth"}}
	activities, err := activities.NewTicketActivities(&readyTicketStore{tickets: want})
	if err != nil {
		t.Fatalf("NewTicketActivities: %v", err)
	}

	got, err := activities.AwaitDispatchableTickets(context.Background())
	if err != nil {
		t.Fatalf("AwaitDispatchableTickets: %v", err)
	}
	if len(got) != 2 || got[0].ID != 2 || got[1].ID != 9 {
		t.Fatalf("AwaitDispatchableTickets() = %+v, want the ready batch %+v", got, want)
	}
}
