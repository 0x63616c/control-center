package workflows

import (
	"fmt"
	"sort"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	enums "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// SignalFactoryTicketDone carries a FactoryTicketDone from a finishing
// Ticket-backed run.
//
// It is a distinct signal from SignalTicketDone, not a reuse: this
// dispatcher's in-flight set is keyed by store.TicketID, a small integer
// minted by our own Postgres identity column, never a GitHub issue number —
// reusing the old signal's name would invite a payload meant for one
// dispatcher's map being decoded against the other's key space.
const SignalFactoryTicketDone = "factory-ticket-done"

// FactoryTicketDone is what FactoryWorkTicket reports when it ends, whatever
// the outcome. Reporting unconditionally (not just on success) is what lets
// the dispatcher free the slot without waiting for its own reconcile sweep.
type FactoryTicketDone struct {
	TicketID store.TicketID
	RunID    string
}

// FactoryDispatcherInput is the independently versionable state of the
// Ticket dispatcher. Its default cap is one because both dispatchers consume
// one shared Codex quota; raising it has a direct quota cost.
//
// It deliberately carries no Breaker and no config-update signal yet: v0
// starts paused-never, capped at one, with no operator control surface of
// its own — extending #548's control commands (which today speak only to
// the legacy DispatcherWorkflowID) to reach this dispatcher too is later
// work, not part of standing the second pipeline up.
type FactoryDispatcherInput struct {
	Config   work.Config
	Tuning   work.DispatcherTuning
	Run      work.RunPolicy
	InFlight []store.InFlightTicket
}

// FactoryDispatcher works factory Tickets read from Postgres, without
// changing Dispatcher or WorkTicket (ADR-0012's Cutover: "the existing pair
// is not modified"). It is registered on the same worker and the same task
// queue as Dispatcher, under a disjoint singleton workflow ID
// (work.FactoryDispatcherWorkflowID) and a disjoint child-workflow-ID
// namespace (work.FactoryTicketWorkflowID) — two dispatchers, two work
// sources, provably unable to collide.
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

	dones := workflow.GetSignalChannel(ctx, SignalFactoryTicketDone)
	var lastSweep time.Time

	for {
		now := workflow.Now(ctx)

		// Phase ordering is load-bearing: drain completions and reconcile
		// before sweeping or starting, so len(inFlight) reflects what is
		// actually still open before either decision is made.
		drainFactoryDones(ctx, dones, inFlight)
		reconcileFactoryTickets(ctx, in.Run, inFlight)
		lastSweep = sweepFactorySandboxes(ctx, in, inFlight, lastSweep, now)
		startFactoryTickets(ctx, in, inFlight)

		if workflow.GetInfo(ctx).GetCurrentHistoryLength() >= in.Tuning.MaxHistoryEvents {
			return continueFactoryDispatcherAsNew(ctx, in, inFlight)
		}

		if !waitFactoryDispatcher(ctx, in.Config.PollInterval(), dones) {
			return ctx.Err()
		}
	}
}

// drainFactoryDones removes every ticket a finishing run has already told us
// about, non-blocking: it drains whatever has arrived since the last tick
// without waiting for more.
func drainFactoryDones(ctx workflow.Context, dones workflow.ReceiveChannel, inFlight map[store.TicketID]store.InFlightTicket) {
	for {
		var done FactoryTicketDone
		if !dones.ReceiveAsync(&done) {
			return
		}
		if existing, ok := inFlight[done.TicketID]; ok && existing.RunID == done.RunID {
			delete(inFlight, done.TicketID)
		}
	}
}

// reconcileFactoryTickets drops in-flight tickets whose runs are no longer
// open — the backstop for a run that dies without signalling (a worker
// killed mid-ticket, a terminated workflow). A completion signal is the fast
// path; this is what stops a slot being held forever when one is lost.
func reconcileFactoryTickets(ctx workflow.Context, run work.RunPolicy, inFlight map[store.TicketID]store.InFlightTicket) {
	actx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: run.ControlTimeout,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: run.ControlAttempts},
	})

	for _, id := range sortedTicketIDs(inFlight) {
		f := inFlight[id]
		var state work.RunState
		if err := workflow.ExecuteActivity(actx, acts.DescribeRun, work.FactoryTicketWorkflowID(int64(id))).Get(ctx, &state); err != nil {
			// A lookup that failed says nothing about the run; releasing the
			// slot on no evidence risks starting a second run of the same
			// Ticket. Leave it in flight and try again next tick.
			workflow.GetLogger(ctx).Error("could not reconcile a factory ticket's run", "ticket_id", int64(id), "error", err)
			continue
		}
		switch {
		case !state.Open:
			delete(inFlight, id)
		case state.RunID != f.RunID:
			f.RunID = state.RunID
			inFlight[id] = f
		}
	}
}

// sweepFactorySandboxes deletes sandbox pods no live factory run owns, no
// more often than the config's orphan grace.
func sweepFactorySandboxes(
	ctx workflow.Context, in FactoryDispatcherInput, inFlight map[store.TicketID]store.InFlightTicket, lastSweep, now time.Time,
) time.Time {
	if !lastSweep.IsZero() && now.Sub(lastSweep) < in.Config.OrphanGrace() {
		return lastSweep
	}

	live := make([]string, 0, len(inFlight))
	for _, id := range sortedTicketIDs(inFlight) {
		live = append(live, inFlight[id].RunID)
	}

	actx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{StartToCloseTimeout: in.Run.ControlTimeout})
	sweepIn := activities.SweepInput{LiveRunIDs: live, MinAge: in.Config.OrphanGrace()}
	if err := workflow.ExecuteActivity(actx, acts.SweepOrphanSandboxes, sweepIn).Get(ctx, nil); err != nil {
		workflow.GetLogger(ctx).Error("sweeping orphaned factory sandboxes failed", "error", err)
	}
	return now
}

// startFactoryTickets lists ready Tickets and starts as many child runs as
// the cap allows.
func startFactoryTickets(ctx workflow.Context, in FactoryDispatcherInput, inFlight map[store.TicketID]store.InFlightTicket) {
	if in.Config.Paused || len(inFlight) >= in.Config.MaxInFlight {
		return
	}

	actx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: in.Run.ControlTimeout,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: in.Run.ControlAttempts},
	})
	var tickets []store.Ticket
	if err := workflow.ExecuteActivity(actx, ticketActs.ListReadyTickets).Get(ctx, &tickets); err != nil {
		workflow.GetLogger(ctx).Error("could not list ready factory tickets", "error", err)
		return
	}

	now := workflow.Now(ctx)
	for _, ticket := range tickets {
		if len(inFlight) >= in.Config.MaxInFlight {
			return
		}
		if _, ok := inFlight[ticket.ID]; ok {
			continue
		}

		options := workflow.ChildWorkflowOptions{
			WorkflowID:         work.FactoryTicketWorkflowID(int64(ticket.ID)),
			TaskQueue:          work.TaskQueue,
			ParentClosePolicy:  enums.PARENT_CLOSE_POLICY_ABANDON,
			WorkflowRunTimeout: in.Run.RunTimeout,
			StaticSummary:      fmt.Sprintf("T-%d %s", ticket.ID, ticket.Title),
		}
		childInput := FactoryWorkTicketInput{
			TicketID:     ticket.ID,
			Config:       in.Config,
			Policy:       in.Run,
			DispatcherID: workflow.GetInfo(ctx).WorkflowExecution.ID,
		}
		child := workflow.ExecuteChildWorkflow(workflow.WithChildOptions(ctx, options), FactoryWorkTicket, childInput)

		var execution workflow.Execution
		if err := child.GetChildWorkflowExecution().Get(ctx, &execution); err != nil {
			if temporal.IsWorkflowExecutionAlreadyStartedError(err) {
				workflow.GetLogger(ctx).Info("factory ticket already has an open run", "ticket_id", int64(ticket.ID))
				continue
			}
			workflow.GetLogger(ctx).Error("could not start a factory ticket's run", "ticket_id", int64(ticket.ID), "error", err)
			continue
		}
		inFlight[ticket.ID] = store.InFlightTicket{TicketID: ticket.ID, RunID: execution.RunID, StartedAt: now}
	}
}

// waitFactoryDispatcher blocks until the poll interval elapses, a completion
// signal arrives, or the workflow is cancelled. It reports whether the loop
// should continue.
func waitFactoryDispatcher(ctx workflow.Context, pollInterval time.Duration, dones workflow.ReceiveChannel) bool {
	timerCtx, cancelTimer := workflow.WithCancel(ctx)
	defer cancelTimer()

	selector := workflow.NewSelector(ctx)
	selector.AddFuture(workflow.NewTimer(timerCtx, pollInterval), func(workflow.Future) {})
	selector.AddReceive(dones, func(workflow.ReceiveChannel, bool) {})
	selector.AddReceive(ctx.Done(), func(workflow.ReceiveChannel, bool) {})
	selector.Select(ctx)

	return ctx.Err() == nil
}

// continueFactoryDispatcherAsNew carries the in-flight set forward, the same
// unbounded-history bound Dispatcher itself uses.
func continueFactoryDispatcherAsNew(ctx workflow.Context, in FactoryDispatcherInput, inFlight map[store.TicketID]store.InFlightTicket) error {
	next := make([]store.InFlightTicket, 0, len(inFlight))
	for _, id := range sortedTicketIDs(inFlight) {
		next = append(next, inFlight[id])
	}
	return workflow.NewContinueAsNewError(ctx, FactoryDispatcher, FactoryDispatcherInput{
		Config: in.Config, Tuning: in.Tuning, Run: in.Run, InFlight: next,
	})
}

// sortedTicketIDs orders a map's keys so every workflow scheduled from it is
// scheduled in the same order on replay — map iteration order is not
// deterministic, and workflow code must be.
func sortedTicketIDs(inFlight map[store.TicketID]store.InFlightTicket) []store.TicketID {
	ids := make([]store.TicketID, 0, len(inFlight))
	for id := range inFlight {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}
