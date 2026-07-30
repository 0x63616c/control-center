package workflows

import (
	"fmt"
	"slices"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	enums "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// DispatcherInput is the dispatcher's whole state, and therefore also what it
// carries across ContinueAsNew.
//
// One struct for both, deliberately: a field that the loop keeps but the
// carried state drops is a field that silently resets every few hours, and the
// in-flight set resetting means the concurrency cap is enforced against
// nothing.
type DispatcherInput struct {
	// Config is the operator's surface, replaced wholesale when an update is
	// accepted. See work.Config.
	Config work.Config

	// Tuning paces the loop, and Run is the policy handed to each child. Both
	// are deploy-time; neither is on the signal.
	Tuning work.DispatcherTuning
	Run    work.RunPolicy

	InFlight []work.InFlightTicket
	Breaker  work.Breaker

	// RecentlyFinished is the tickets whose runs have just ended, each still
	// protected from a re-claim until its ExpiresAt (#405). It is carried
	// across ContinueAsNew for the same reason InFlight is: a guard kept only
	// in the loop and dropped here would reset every few hours, and the bug it
	// closes would come back intermittently instead of staying fixed.
	RecentlyFinished []work.FinishedTicket

	// ConfigError is why the last update was rejected. It is carried across
	// ContinueAsNew because an operator reading GetStatus after a run boundary
	// would otherwise see their rejected update turn into silence.
	ConfigError string

	// LastSweep is when the orphan sweep last ran, so continuing as new does
	// not restart its cadence and turn a half-hourly reconcile into a
	// per-restart one.
	LastSweep time.Time
}

// Dispatcher owns the control plane: it decides which tickets are worked, how
// many at once, and when the system should stop taking work on.
//
// It is a timer loop holding its state in workflow state rather than a
// Schedule, because concurrency is `len(inFlight) < cap` against that state —
// durable, strongly consistent, and needing no coordination primitive. It is
// notably not the visibility store: visibility is a search index and eventually
// consistent, so using it as a semaphore would be a race dressed as a query.
func Dispatcher(ctx workflow.Context, in DispatcherInput) error {
	if err := validateDispatcher(in); err != nil {
		return err
	}

	d := newDispatcher(in)
	if err := workflow.SetQueryHandler(ctx, QueryStatus, d.status); err != nil {
		return fmt.Errorf("registering the %s query: %w", QueryStatus, err)
	}

	updates := workflow.GetSignalChannel(ctx, SignalUpdateConfig)
	dones := workflow.GetSignalChannel(ctx, SignalTicketDone)

	for {
		d.tick(ctx)

		if workflow.GetInfo(ctx).GetCurrentHistoryLength() >= d.tuning.MaxHistoryEvents {
			return d.continueAsNew(ctx, updates, dones)
		}

		if !d.wait(ctx, updates, dones) {
			return ctx.Err()
		}
	}
}

// validateDispatcher refuses an input the loop could not run on, before it
// starts anything. All three parts are checked rather than the first that
// fails, because a deploy with two wrong numbers should learn both.
func validateDispatcher(in DispatcherInput) error {
	for _, err := range []error{in.Config.Validate(), in.Tuning.Validate(), in.Run.Validate()} {
		if err != nil {
			return temporal.NewNonRetryableApplicationError(
				fmt.Sprintf("the dispatcher cannot run on this input: %v", err), activities.ErrTypeInvalid, nil)
		}
	}
	return nil
}

// applyUpdate accepts a config update or records why it was refused.
//
// Recording is the whole point. A Temporal signal cannot fail back to its
// sender, so an update that was rejected and one that was applied look
// identical from the outside — and the moment an operator is signalling a live
// dispatcher is the moment they can least afford to assume. The error goes to
// Status.ConfigError, which is the only channel a signal has, and a later
// update that succeeds clears it so a stale complaint cannot outlive the
// mistake.
func (d *dispatcher) applyUpdate(ctx workflow.Context, update work.ConfigUpdate) {
	log := workflow.GetLogger(ctx)

	next, err := d.config.Apply(update)
	if err != nil {
		d.configError = err.Error()
		log.Error("rejected a config update", "error", err)
		return
	}

	// An operator un-pausing by hand is also saying the reason no longer
	// applies, unless they sent one. Leaving it set would have GetStatus
	// explain a pause that is over.
	if d.config.Paused && !next.Paused && update.PauseReason == nil {
		next.PauseReason = ""
	}

	d.config = next
	d.configError = ""
	log.Info("config updated", "max_in_flight", d.config.MaxInFlight, "paused", d.config.Paused)
}

// dispatcher is the loop's state. It is a struct rather than locals so that
// the same value is what the query reads and what ContinueAsNew carries.
type dispatcher struct {
	config      work.Config
	tuning      work.DispatcherTuning
	run         work.RunPolicy
	inFlight    map[int]work.InFlightTicket
	breaker     work.Breaker
	configError string
	lastSweep   time.Time

	// recentlyFinished is the ticket -> cooldown-expiry map behind
	// RecentlyFinished (#405). It is keyed the same way inFlight is, for the
	// same reason: O(1) membership at the point start() decides whether a
	// listed ticket may be claimed.
	recentlyFinished map[int]time.Time

	// now is the last tick's time. A query handler runs outside the workflow's
	// own goroutine and cannot ask for the time, so the breaker state it
	// reports is as of the last tick — at most one poll interval stale, and
	// honest about it.
	now time.Time
}

func newDispatcher(in DispatcherInput) *dispatcher {
	inFlight := make(map[int]work.InFlightTicket, len(in.InFlight))
	for _, ticket := range in.InFlight {
		inFlight[ticket.Ticket] = ticket
	}
	recentlyFinished := make(map[int]time.Time, len(in.RecentlyFinished))
	for _, ticket := range in.RecentlyFinished {
		recentlyFinished[ticket.Ticket] = ticket.ExpiresAt
	}
	return &dispatcher{
		config:           in.Config,
		tuning:           in.Tuning,
		run:              in.Run,
		inFlight:         inFlight,
		breaker:          in.Breaker,
		configError:      in.ConfigError,
		lastSweep:        in.LastSweep,
		recentlyFinished: recentlyFinished,
	}
}

// tick is one pass of the loop: find out what is true, tidy up after what is
// not, then take on more work if there is room.
//
// The order matters. Reconciling before starting is what stops a run that died
// without saying so from holding its slot until someone notices.
func (d *dispatcher) tick(ctx workflow.Context) {
	d.now = workflow.Now(ctx)
	d.reconcile(ctx)
	d.pruneFinished()
	d.sweep(ctx)
	d.start(ctx)
}

// wait blocks until the poll interval elapses, a signal arrives, or the
// workflow is cancelled. It reports whether the loop should continue.
func (d *dispatcher) wait(ctx workflow.Context, updates, dones workflow.ReceiveChannel) bool {
	// The timer is cancelled on the way out so a signal-driven iteration does
	// not leave a live timer behind on every pass. Left uncancelled they
	// accumulate in history, which is the one thing this loop is built to bound.
	timerCtx, cancelTimer := workflow.WithCancel(ctx)
	defer cancelTimer()

	selector := workflow.NewSelector(ctx)
	selector.AddFuture(workflow.NewTimer(timerCtx, d.config.PollInterval()), func(workflow.Future) {})
	selector.AddReceive(updates, func(c workflow.ReceiveChannel, _ bool) { d.receiveUpdate(ctx, c) })
	selector.AddReceive(dones, func(c workflow.ReceiveChannel, _ bool) { d.receiveDone(ctx, c) })
	selector.AddReceive(ctx.Done(), func(workflow.ReceiveChannel, bool) {})
	selector.Select(ctx)

	return ctx.Err() == nil
}

// reconcile drops the tickets whose runs are no longer open.
//
// A completion signal is the fast path and this is the backstop: a run that
// dies without signalling — a worker killed mid-ticket, a terminated workflow —
// would otherwise hold its slot for as long as the dispatcher lives.
//
// It is DescribeWorkflowExecution by workflow ID: a point lookup, strongly
// consistent, and not a search.
func (d *dispatcher) reconcile(ctx workflow.Context) {
	ctx = workflow.WithActivityOptions(ctx, d.activityOptions())

	// Sorted, because a workflow that scheduled activities in map order would
	// schedule them in a different order on replay, and replay determinism is
	// not negotiable.
	for _, ticket := range sortedTickets(d.inFlight) {
		inFlight := d.inFlight[ticket]

		var state work.RunState
		if err := workflow.ExecuteActivity(ctx, acts.DescribeRun, work.WorkflowID(ticket)).Get(ctx, &state); err != nil {
			// Leave it in flight. A lookup that failed says nothing about the
			// run, and releasing a slot on no evidence would start a second run
			// against a ticket that already has one.
			d.noteFailure(ctx, err, fmt.Sprintf("reconciling ticket #%d", ticket))
			continue
		}

		switch {
		case !state.Open:
			workflow.GetLogger(ctx).Info("released a ticket whose run is gone",
				"ticket", ticket, "run_id", inFlight.RunID)
			delete(d.inFlight, ticket)
			d.markFinished(ticket, d.now)
		case state.RunID != inFlight.RunID:
			// Someone restarted this ticket. The slot is still taken; it is
			// taken by a different run, and the sweep must not delete that
			// run's pod.
			inFlight.RunID = state.RunID
			d.inFlight[ticket] = inFlight
		}
	}
}

// sweep deletes sandbox pods no live run owns.
//
// It runs on the orphan grace rather than on the poll interval. The thing it
// catches — a worker that died mid-ticket, taking with it the workflow that
// would have deleted the pod — is rare and costs a pod, so reconciling it every
// thirty seconds would be a Kubernetes call per poll for nothing.
func (d *dispatcher) sweep(ctx workflow.Context) {
	now := workflow.Now(ctx)
	if !d.lastSweep.IsZero() && now.Sub(d.lastSweep) < d.config.OrphanGrace() {
		return
	}
	d.lastSweep = now

	ctx = workflow.WithActivityOptions(ctx, d.activityOptions())

	in := activities.SweepInput{LiveRunIDs: d.liveRunIDs(), MinAge: d.config.OrphanGrace()}
	var result activities.SweepResult
	if err := workflow.ExecuteActivity(ctx, acts.SweepOrphanSandboxes, in).Get(ctx, &result); err != nil {
		d.noteFailure(ctx, err, "sweeping orphaned sandboxes")
	}
}

// liveRunIDs is what the sweep must not delete. It is built from the in-flight
// set after reconcile, so a run that has already ended does not protect its own
// leftover pod.
func (d *dispatcher) liveRunIDs() []string {
	live := make([]string, 0, len(d.inFlight))
	for _, ticket := range sortedTickets(d.inFlight) {
		live = append(live, d.inFlight[ticket].RunID)
	}
	return live
}

// start takes on as much new work as the cap, the pause and the breaker allow.
func (d *dispatcher) start(ctx workflow.Context) {
	log := workflow.GetLogger(ctx)

	if d.config.Paused {
		log.Debug("paused, starting nothing", "reason", d.config.PauseReason)
		return
	}
	if d.breaker.OpenAt(workflow.Now(ctx)) {
		log.Debug("breaker open, starting nothing", "reason", d.breaker.Reason, "until", d.breaker.OpenUntil)
		return
	}

	free := d.config.MaxInFlight - len(d.inFlight)
	if free <= 0 {
		return
	}

	activityCtx := workflow.WithActivityOptions(ctx, d.activityOptions())
	var tickets []work.Ticket
	if err := workflow.ExecuteActivity(activityCtx, acts.ListAutoTickets).Get(ctx, &tickets); err != nil {
		d.noteFailure(ctx, err, "listing tickets labelled auto")
		return
	}

	for _, ticket := range tickets {
		if free == 0 {
			return
		}
		if _, taken := d.inFlight[ticket.Number]; taken {
			continue
		}
		if d.reclaimBlocked(ticket.Number, workflow.Now(ctx)) {
			// GitHub's issue index is eventually consistent (#405): a ticket
			// this dispatcher just finished can still be listed here for a
			// few seconds after its `auto` label was cleared. Skipping it is
			// what stops that stale read from starting a second run against
			// work the system already decided it was done with.
			log.Debug("skipped a ticket still inside its post-finish cooldown", "ticket", ticket.Number)
			continue
		}

		var autoLabelPresent bool
		if err := workflow.ExecuteActivity(activityCtx, acts.AutoLabelPresent, ticket.Number).Get(ctx, &autoLabelPresent); err != nil {
			d.noteFailure(ctx, err, fmt.Sprintf("checking the auto label on ticket #%d", ticket.Number))
			return
		}
		if !autoLabelPresent {
			// ListAutoTickets reads GitHub's label index, which can lag a label
			// removal. The primary issue read is the eligibility decision right
			// next to the claim, while the cooldown remains a second backstop.
			log.Debug("skipped a ticket whose auto label is no longer present", "ticket", ticket.Number)
			continue
		}

		if d.claim(ctx, ticket) {
			free--
		}
	}
}

// claim starts a run for one ticket, or adopts the run that already owns it,
// and reports whether a slot was consumed.
//
// The claim itself is Temporal's: starting a workflow with this ticket's ID is
// refused while another run holds it, so uniqueness replaces a lease table. The
// lookup below is not the claim — it is how a dispatcher that has forgotten a
// run finds it again. Without it, a run this dispatcher no longer knows about
// does not count against the cap, and the system quietly works more tickets at
// once than it was told to.
func (d *dispatcher) claim(ctx workflow.Context, ticket work.Ticket) bool {
	log := workflow.GetLogger(ctx)
	now := workflow.Now(ctx)

	activityCtx := workflow.WithActivityOptions(ctx, d.activityOptions())
	var existing work.RunState
	if err := workflow.ExecuteActivity(activityCtx, acts.DescribeRun, work.WorkflowID(ticket.Number)).Get(ctx, &existing); err != nil {
		d.noteFailure(ctx, err, fmt.Sprintf("checking whether ticket #%d is already being worked", ticket.Number))
		return false
	}
	if existing.Open {
		log.Info("adopted a run this dispatcher had forgotten", "ticket", ticket.Number, "run_id", existing.RunID)
		d.inFlight[ticket.Number] = work.InFlightTicket{Ticket: ticket.Number, RunID: existing.RunID, StartedAt: now}
		return true
	}

	childCtx := workflow.WithChildOptions(ctx, d.childOptions(ticket))
	child := workflow.ExecuteChildWorkflow(childCtx, WorkTicket, WorkTicketInput{
		Ticket:       ticket,
		Config:       d.config,
		Policy:       d.run,
		DispatcherID: workflow.GetInfo(ctx).WorkflowExecution.ID,
	})

	// Waiting for the child to *start* is load-bearing: ContinueAsNew closes
	// this run, and a child that has not started by then never starts at all.
	// Waiting for it to finish would be the opposite mistake — that is what the
	// completion signal is for.
	var execution workflow.Execution
	if err := child.GetChildWorkflowExecution().Get(ctx, &execution); err != nil {
		// Not fatal, and not a reason to record a slot: the next tick's lookup
		// adopts the run if it did in fact start.
		log.Error("could not start a run for this ticket", "ticket", ticket.Number, "error", err)
		d.noteFailure(ctx, err, fmt.Sprintf("starting a run for ticket #%d", ticket.Number))
		return false
	}

	d.inFlight[ticket.Number] = work.InFlightTicket{
		Ticket:    ticket.Number,
		RunID:     execution.RunID,
		StartedAt: now,
	}
	log.Info("started a run", "ticket", ticket.Number, "run_id", execution.RunID)
	return true
}

// receiveUpdate applies a config update, or discards one the dispatcher cannot
// run on.
//
// Discarding rather than failing: an unusable update is a message, not a
// broken system, and a dispatcher that died on a mistyped signal would take
// every in-flight ticket's supervision with it.
func (d *dispatcher) receiveUpdate(ctx workflow.Context, c workflow.ReceiveChannel) {
	var update work.ConfigUpdate
	c.Receive(ctx, &update)

	d.applyUpdate(ctx, update)
}

// receiveDone frees a finishing run's slot and acts on what it reported.
func (d *dispatcher) receiveDone(ctx workflow.Context, c workflow.ReceiveChannel) {
	var done work.TicketDone
	c.Receive(ctx, &done)

	log := workflow.GetLogger(ctx)

	// A report from a run this dispatcher has already replaced must not free
	// the current run's slot: the ticket is still being worked, by someone else.
	if inFlight, ok := d.inFlight[done.Ticket]; ok && inFlight.RunID == done.RunID {
		delete(d.inFlight, done.Ticket)
		d.markFinished(done.Ticket, workflow.Now(ctx))
	} else if ok {
		log.Warn("ignored a completion report from a superseded run",
			"ticket", done.Ticket, "reported_run", done.RunID, "current_run", inFlight.RunID)
	}

	log.Info("a ticket finished",
		"ticket", done.Ticket, "outcome", string(done.Outcome), "failure", string(done.Failure))

	d.act(ctx, done.Failure, fmt.Sprintf("ticket #%d: %s", done.Ticket, done.Detail))
}

// noteFailure turns one of the dispatcher's own activity failures into the same
// two decisions a child's report produces, so the system reacts to a dead
// credential identically wherever it is first seen.
func (d *dispatcher) noteFailure(ctx workflow.Context, err error, what string) {
	workflow.GetLogger(ctx).Error("dispatcher activity failed", "what", what, "error", err)
	d.act(ctx, activities.FailureKindOf(err), fmt.Sprintf("%s: %v", what, err))
}

// act is the whole of what the dispatcher does about a failure, in one place so
// the two callers cannot diverge.
func (d *dispatcher) act(ctx workflow.Context, failure work.FailureKind, detail string) {
	switch failure {
	case work.FailureAuth:
		// Nothing the dispatcher does next will work, and the ticket that
		// triggered this may still carry its `auto` label — so polling on would
		// re-list it every interval, forever. Stopping is the only thing that
		// bounds that (#333, #339).
		if !d.config.Paused {
			workflow.GetLogger(ctx).Error("pausing: a credential is not usable", "detail", detail)
		}
		d.config.Paused = true
		d.config.PauseReason = detail
	case work.FailureRateLimit:
		d.breaker = d.breaker.TrippedAt(workflow.Now(ctx), d.config.BreakerCooldown(), detail)
		workflow.GetLogger(ctx).Warn("breaker tripped", "until", d.breaker.OpenUntil, "detail", detail)
	case work.FailureNone, work.FailureOther:
		// One ticket's problem. The slot is already free; nothing else changes.
	}
}

// continueAsNew bounds the loop's history.
//
// The drain is not housekeeping. A signal delivered in the same workflow task
// that decides to continue is sitting unread in its channel, and a
// ContinueAsNew that did not read it would discard it with the run — losing a
// human's pause, or a child's report of the auth failure that should have
// caused one.
func (d *dispatcher) continueAsNew(ctx workflow.Context, updates, dones workflow.ReceiveChannel) error {
	for {
		var update work.ConfigUpdate
		if updates.ReceiveAsync(&update) {
			d.applyUpdate(ctx, update)
			continue
		}

		var done work.TicketDone
		if dones.ReceiveAsync(&done) {
			if inFlight, ok := d.inFlight[done.Ticket]; ok && inFlight.RunID == done.RunID {
				delete(d.inFlight, done.Ticket)
				d.markFinished(done.Ticket, workflow.Now(ctx))
			}
			d.act(ctx, done.Failure, fmt.Sprintf("ticket #%d: %s", done.Ticket, done.Detail))
			continue
		}

		return workflow.NewContinueAsNewError(ctx, Dispatcher, d.input())
	}
}

// input is the state as it crosses a run boundary.
func (d *dispatcher) input() DispatcherInput {
	in := DispatcherInput{
		Config:           d.config,
		Tuning:           d.tuning,
		Run:              d.run,
		InFlight:         make([]work.InFlightTicket, 0, len(d.inFlight)),
		Breaker:          d.breaker,
		ConfigError:      d.configError,
		LastSweep:        d.lastSweep,
		RecentlyFinished: make([]work.FinishedTicket, 0, len(d.recentlyFinished)),
	}
	for _, ticket := range sortedTickets(d.inFlight) {
		in.InFlight = append(in.InFlight, d.inFlight[ticket])
	}
	for _, ticket := range sortedFinished(d.recentlyFinished) {
		in.RecentlyFinished = append(in.RecentlyFinished, work.FinishedTicket{Ticket: ticket, ExpiresAt: d.recentlyFinished[ticket]})
	}
	return in
}

// status answers the one query: what is being worked, and why nothing more is.
func (d *dispatcher) status() (work.Status, error) {
	tickets := sortedTickets(d.inFlight)
	return work.Status{
		Config:      d.config,
		InFlight:    tickets,
		Breaker:     d.breaker,
		ConfigError: d.configError,
	}, nil
}

// childOptions are how a ticket's run is started.
//
// ParentClosePolicy ABANDON is required, not stylistic. The default is
// TERMINATE and ContinueAsNew closes the parent run, so the default would have
// the dispatcher kill every ticket it had just started, every few hours.
func (d *dispatcher) childOptions(ticket work.Ticket) workflow.ChildWorkflowOptions {
	return workflow.ChildWorkflowOptions{
		WorkflowID:         work.WorkflowID(ticket.Number),
		ParentClosePolicy:  enums.PARENT_CLOSE_POLICY_ABANDON,
		WorkflowRunTimeout: d.run.RunTimeout,
		StaticSummary:      fmt.Sprintf("#%d %s", ticket.Number, ticket.Title),
		StaticDetails:      fmt.Sprintf("[GitHub issue #%d](https://github.com/0x63616c/world-wide-webb/issues/%d)", ticket.Number, ticket.Number),
	}
}

// sortedTickets returns the in-flight ticket numbers in a fixed order. Go
// randomises map iteration, and a workflow whose activity order changed between
// runs would fail replay.
func sortedTickets(inFlight map[int]work.InFlightTicket) []int {
	tickets := make([]int, 0, len(inFlight))
	for ticket := range inFlight {
		tickets = append(tickets, ticket)
	}
	slices.Sort(tickets)
	return tickets
}

// markFinished records that ticket's run has just ended, protecting it from a
// re-claim until now plus the configured cooldown (#405).
//
// The deadline is stamped once, at the moment of the call, and never
// recomputed from now — the same reasoning as Breaker.TrippedAt: a ticket
// that finishes twice in quick succession (a completion signal racing the
// reconcile backstop for the same slot) must not have its protection
// shortened by whichever of the two runs second.
func (d *dispatcher) markFinished(ticket int, now time.Time) {
	until := now.Add(d.tuning.ReclaimCooldown)
	if existing, ok := d.recentlyFinished[ticket]; ok && !until.After(existing) {
		return
	}
	d.recentlyFinished[ticket] = until
}

// reclaimBlocked reports whether ticket is still inside its post-finish
// cooldown and must not be started even though ListAutoTickets named it.
func (d *dispatcher) reclaimBlocked(ticket int, now time.Time) bool {
	until, ok := d.recentlyFinished[ticket]
	return ok && now.Before(until)
}

// pruneFinished drops cooldowns that have already expired.
//
// Without this, recentlyFinished would grow by one entry for every ticket
// this dispatcher ever finishes and never shrink — the dispatcher is meant to
// run for months across ContinueAsNew, so an unbounded map here is exactly
// the kind of state this loop exists to avoid. It runs every tick rather than
// only when a ticket finishes, so a ticket nobody looks at again is still
// forgotten once its cooldown lapses. Deletion order is unobserved by
// anything replay-sensitive — no activity is scheduled here — so it does not
// need sortedTickets' fixed order.
func (d *dispatcher) pruneFinished() {
	for ticket, until := range d.recentlyFinished {
		if !d.now.Before(until) {
			delete(d.recentlyFinished, ticket)
		}
	}
}

// sortedFinished returns the recently-finished ticket numbers in a fixed
// order, for the same replay-determinism reason as sortedTickets — this one
// is walked only when building carried state, but a fixed order costs
// nothing and keeps the pattern uniform.
func sortedFinished(recentlyFinished map[int]time.Time) []int {
	tickets := make([]int, 0, len(recentlyFinished))
	for ticket := range recentlyFinished {
		tickets = append(tickets, ticket)
	}
	slices.Sort(tickets)
	return tickets
}

// activityOptions govern the dispatcher's own activities. They are all cheap
// lookups, and none of them is worth stalling the loop for.
func (d *dispatcher) activityOptions() workflow.ActivityOptions {
	return workflow.ActivityOptions{
		StartToCloseTimeout: d.run.ControlTimeout,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: d.run.ControlAttempts},
	}
}
