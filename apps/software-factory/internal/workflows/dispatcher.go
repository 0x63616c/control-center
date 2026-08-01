package workflows

import (
	"fmt"
	"sort"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	enums "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// UpdateDispatcherPolicy is the acknowledged update used to publish a worker's
// complete resolved policy before it begins polling the main task queue.
const UpdateDispatcherPolicy = "publish-dispatcher-policy"

// DispatcherInput is the durable target-dispatcher state. Live child Futures
// never cross a Continue-As-New boundary: the workflow drains first.
type DispatcherInput struct {
	Policy   work.DispatcherPolicy
	CloneURL string
	Model    work.Model
}

// DispatcherPublication is the durable outcome of a policy publication.
type DispatcherPublication string

const (
	// DispatcherPublicationApplied means a different resolved policy became current.
	DispatcherPublicationApplied DispatcherPublication = "APPLIED"
	// DispatcherPublicationAlreadyCurrent means the fingerprint matched current policy.
	DispatcherPublicationAlreadyCurrent DispatcherPublication = "ALREADY_CURRENT"
	// DispatcherPublicationDraining tells callers to retry after the rollover.
	DispatcherPublicationDraining DispatcherPublication = "DRAINING"
)

// DispatcherPolicyUpdate is one idempotently named policy publication. Request
// identity belongs to Temporal's Update ID, not to this payload.
type DispatcherPolicyUpdate struct {
	Fingerprint string
	Policy      work.DispatcherPolicy
}

// Dispatcher admits target WorkOnTicket children. Idle polling is represented
// by the retry state of AwaitDispatchableTickets, not workflow timers.
func Dispatcher(ctx workflow.Context, in DispatcherInput) error {
	if err := validateDispatcherInput(in); err != nil {
		return temporal.NewNonRetryableApplicationError(err.Error(), activities.ErrTypeInvalid, nil)
	}
	policy := in.Policy
	fingerprint, err := policy.Fingerprint()
	if err != nil {
		return temporal.NewNonRetryableApplicationError(err.Error(), activities.ErrTypeInvalid, nil)
	}
	draining := false
	if err := workflow.SetUpdateHandler(ctx, UpdateDispatcherPolicy, func(_ workflow.Context, update DispatcherPolicyUpdate) (DispatcherPublication, error) {
		next, err := update.Policy.Fingerprint()
		if err != nil || update.Fingerprint != next {
			return "", temporal.NewNonRetryableApplicationError("published dispatcher policy fingerprint is invalid", activities.ErrTypeInvalid, err)
		}
		if update.Fingerprint == fingerprint {
			return DispatcherPublicationAlreadyCurrent, nil
		}
		if draining {
			return DispatcherPublicationDraining, nil
		}
		policy, fingerprint = update.Policy, update.Fingerprint
		return DispatcherPublicationApplied, nil
	}); err != nil {
		return fmt.Errorf("registering dispatcher policy update: %w", err)
	}

	children := map[store.TicketID]workflow.ChildWorkflowFuture{}
	var wait workflow.Future
	var cancelWait workflow.CancelFunc

	for {
		if workflow.GetInfo(ctx).GetContinueAsNewSuggested() && !draining {
			draining = true
			if cancelWait != nil {
				cancelWait()
				wait, cancelWait = nil, nil
			}
		}
		if draining && len(children) == 0 {
			return workflow.NewContinueAsNewError(ctx, Dispatcher, DispatcherInput{Policy: policy, CloneURL: in.CloneURL, Model: in.Model})
		}
		if !draining && wait == nil && len(children) < policy.MaxInFlight {
			waitCtx, cancel := workflow.WithCancel(ctx)
			wait = workflow.ExecuteActivity(workflow.WithActivityOptions(waitCtx, targetActivityOptions(policy.Run.Recording)), ticketActs.AwaitDispatchableTickets)
			cancelWait = cancel
		}

		selector := workflow.NewSelector(ctx)
		if wait != nil {
			selector.AddFuture(wait, func(f workflow.Future) {
				defer cancelWait()
				wait, cancelWait = nil, nil
				var tickets []store.Ticket
				if err := f.Get(ctx, &tickets); err != nil {
					return
				}
				for _, ticket := range sortedDispatchableTickets(tickets) {
					if len(children) >= policy.MaxInFlight {
						return
					}
					if _, exists := children[ticket.ID]; exists {
						continue
					}
					child := workflow.ExecuteChildWorkflow(workflow.WithChildOptions(ctx, workflow.ChildWorkflowOptions{WorkflowID: work.FactoryTicketWorkflowID(int64(ticket.ID)), ParentClosePolicy: enums.PARENT_CLOSE_POLICY_REQUEST_CANCEL}), WorkOnTicket, WorkOnTicketInput{TicketID: ticket.ID, Policy: policy.Run, CloneURL: in.CloneURL, Model: in.Model})
					children[ticket.ID] = child
				}
			})
		}
		for _, id := range sortedChildTicketIDs(children) {
			child := children[id]
			id, child := id, child
			selector.AddFuture(child, func(workflow.Future) { delete(children, id) })
		}
		selector.AddReceive(ctx.Done(), func(workflow.ReceiveChannel, bool) {})
		selector.Select(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
}

func validateDispatcherInput(in DispatcherInput) error {
	if err := in.Policy.Validate(); err != nil {
		return err
	}
	if in.CloneURL == "" || in.Model.Name == "" {
		return fmt.Errorf("dispatcher requires a repository URL and model")
	}
	return nil
}

func sortedDispatchableTickets(tickets []store.Ticket) []store.Ticket {
	sorted := append([]store.Ticket(nil), tickets...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].ID < sorted[j].ID })
	return sorted
}

func sortedChildTicketIDs(children map[store.TicketID]workflow.ChildWorkflowFuture) []store.TicketID {
	ids := make([]store.TicketID, 0, len(children))
	for id := range children {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}
