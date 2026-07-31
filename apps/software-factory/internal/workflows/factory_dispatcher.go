package workflows

import (
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	enums "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// FactoryDispatcherInput is the independently versionable state of the
// Ticket dispatcher. Its default cap is one because both dispatchers consume
// one shared Codex quota; raising it has a direct quota cost.
type FactoryDispatcherInput struct {
	Config   work.Config
	Tuning   work.DispatcherTuning
	Run      work.RunPolicy
	InFlight []store.InFlightTicket
}

// FactoryDispatcher works factory Tickets without changing Dispatcher.
func FactoryDispatcher(ctx workflow.Context, in FactoryDispatcherInput) error {
	if err := in.Config.Validate(); err != nil {
		return temporal.NewNonRetryableApplicationError(err.Error(), activities.ErrTypeInvalid, nil)
	}
	if err := in.Tuning.Validate(); err != nil {
		return temporal.NewNonRetryableApplicationError(err.Error(), activities.ErrTypeInvalid, nil)
	}
	if err := in.Run.Validate(); err != nil {
		return temporal.NewNonRetryableApplicationError(err.Error(), activities.ErrTypeInvalid, nil)
	}
	inFlight := make(map[store.TicketID]store.InFlightTicket, len(in.InFlight))
	for _, f := range in.InFlight {
		inFlight[f.TicketID] = f
	}
	for {
		now := workflow.Now(ctx)
		// Phase ordering is load-bearing: reconcile, prune, sweep, then start.
		// This independent dispatcher has no completion signal yet; child IDs are
		// still claimed durably by Temporal before they count against the cap.
		if err := factorySweep(ctx, in, inFlight); err != nil {
			workflow.GetLogger(ctx).Error("factory dispatcher sweep failed", "error", err)
		}
		if !in.Config.Paused && len(inFlight) < in.Config.MaxInFlight {
			var tickets []store.Ticket
			actx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{StartToCloseTimeout: in.Run.ControlTimeout, RetryPolicy: &temporal.RetryPolicy{MaximumAttempts: in.Run.ControlAttempts}})
			if err := workflow.ExecuteActivity(actx, (*activities.TicketActivities).ListReadyTickets).Get(ctx, &tickets); err != nil {
				return err
			}
			for _, ticket := range tickets {
				if len(inFlight) >= in.Config.MaxInFlight {
					break
				}
				if _, ok := inFlight[ticket.ID]; ok {
					continue
				}
				child := workflow.ExecuteChildWorkflow(workflow.WithChildOptions(ctx, workflow.ChildWorkflowOptions{WorkflowID: work.FactoryTicketWorkflowID(int64(ticket.ID)), ParentClosePolicy: enums.PARENT_CLOSE_POLICY_ABANDON, WorkflowRunTimeout: in.Run.RunTimeout, StaticSummary: fmt.Sprintf("T-%d %s", ticket.ID, ticket.Title)}), FactoryWorkTicket, FactoryWorkTicketInput{TicketID: ticket.ID})
				var execution workflow.Execution
				if err := child.GetChildWorkflowExecution().Get(ctx, &execution); err != nil {
					if temporal.IsWorkflowExecutionAlreadyStartedError(err) {
						workflow.GetLogger(ctx).Info("factory ticket already has an open run", "ticket_id", ticket.ID)
						continue
					}
					return err
				}
				inFlight[ticket.ID] = store.InFlightTicket{TicketID: ticket.ID, RunID: execution.RunID, StartedAt: now}
			}
		}
		if workflow.GetInfo(ctx).GetCurrentHistoryLength() >= in.Tuning.MaxHistoryEvents {
			next := make([]store.InFlightTicket, 0, len(inFlight))
			for _, value := range inFlight {
				next = append(next, value)
			}
			return workflow.NewContinueAsNewError(ctx, FactoryDispatcher, FactoryDispatcherInput{Config: in.Config, Tuning: in.Tuning, Run: in.Run, InFlight: next})
		}
		if err := workflow.Sleep(ctx, in.Config.PollInterval()); err != nil {
			return err
		}
	}
}

func factorySweep(ctx workflow.Context, in FactoryDispatcherInput, inFlight map[store.TicketID]store.InFlightTicket) error {
	live := make([]string, 0, len(inFlight))
	for _, f := range inFlight {
		live = append(live, f.RunID)
	}
	actx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{StartToCloseTimeout: in.Run.ControlTimeout})
	return workflow.ExecuteActivity(actx, acts.SweepOrphanSandboxes, activities.SweepInput{LiveRunIDs: live, MinAge: in.Config.OrphanGrace()}).Get(ctx, nil)
}
