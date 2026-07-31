package workflows

import (
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"go.temporal.io/sdk/workflow"
)

// FactoryWorkTicketInput identifies a factory-owned Ticket.
type FactoryWorkTicketInput struct{ TicketID store.TicketID }

// FactoryWorkTicket owns only the Ticket lifecycle. The stage orchestration is
// deliberately kept separate from WorkTicket so legacy histories are untouched.
func FactoryWorkTicket(ctx workflow.Context, in FactoryWorkTicketInput) error {
	actx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{})
	if err := workflow.ExecuteActivity(actx, (*activities.TicketActivities).TransitionTicketState, in.TicketID, store.TicketOpen, store.TicketWorking).Get(ctx, nil); err != nil {
		return err
	}
	var ticket store.Ticket
	if err := workflow.ExecuteActivity(actx, (*activities.TicketActivities).ReadTicket, in.TicketID).Get(ctx, &ticket); err != nil {
		_ = workflow.ExecuteActivity(actx, (*activities.TicketActivities).TransitionTicketState, in.TicketID, store.TicketWorking, store.TicketFailed).Get(ctx, nil)
		return err
	}
	return nil
}
