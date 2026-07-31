package storefake_test

import (
	"context"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store/storefake"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

type readyReader interface {
	ReadyTickets(context.Context) ([]work.FactoryTicket, error)
}

func TestReadyTicketsWaitForEveryDirectBlocker(t *testing.T) {
	ctx := context.Background()
	s := storefake.New()
	a, _ := s.CreateTicket(ctx, "a", "")
	b, _ := s.CreateTicket(ctx, "b", "")
	target, _ := s.CreateTicket(ctx, "target", "")
	if err := s.AddDependency(ctx, a.ID, target.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.AddDependency(ctx, b.ID, target.ID); err != nil {
		t.Fatal(err)
	}
	assertReady(t, s, a.ID, b.ID)
	if _, err := s.SetTicketState(ctx, a.ID, work.TicketStateDone); err != nil {
		t.Fatal(err)
	}
	assertReady(t, s, b.ID)
	if _, err := s.SetTicketState(ctx, b.ID, work.TicketStateDone); err != nil {
		t.Fatal(err)
	}
	assertReady(t, s, target.ID)
}

func assertReady(t *testing.T, s readyReader, want ...work.TicketID) {
	t.Helper()
	got, err := s.ReadyTickets(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(want) {
		t.Fatalf("ready len=%d, want %d", len(got), len(want))
	}
	for i, id := range want {
		if got[i].ID != id {
			t.Fatalf("ready[%d]=%d, want %d", i, got[i].ID, id)
		}
	}
}
