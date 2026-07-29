package workflows_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
	"github.com/stretchr/testify/mock"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"
)

// dispatcherHarness runs the dispatcher against fakes for a fixed slice of
// virtual time, then lets a test read what it decided.
type dispatcherHarness struct {
	env *testsuite.TestWorkflowEnvironment

	// knobs.
	config        work.Config
	tuning        work.DispatcherTuning
	inFlight      []work.InFlightTicket
	breaker       work.Breaker
	tickets       []work.Ticket
	listErr       error
	runs          map[string]work.RunState
	sweepErr      error
	historyLength int
	runFor        time.Duration
	callbacks     []delayedCallback

	// what it did.
	started   []int
	described []string
	sweeps    []activities.SweepInput
}

type delayedCallback struct {
	at time.Duration
	fn func()
}

func newDispatcherHarness(t *testing.T) *dispatcherHarness {
	t.Helper()
	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestWorkflowEnvironment()
	env.SetDetachedChildWait(false)

	tuning := work.DefaultDispatcherTuning()
	// High enough that no test continues as new unless it asks to.
	tuning.MaxHistoryEvents = 1_000_000

	return &dispatcherHarness{
		env:    env,
		config: work.DefaultConfig(),
		tuning: tuning,
		runs:   map[string]work.RunState{},
		runFor: 90 * time.Second,
	}
}

// at schedules something to happen while the dispatcher is looping — a signal,
// usually.
func (h *dispatcherHarness) at(d time.Duration, fn func()) {
	h.callbacks = append(h.callbacks, delayedCallback{at: d, fn: fn})
}

func (h *dispatcherHarness) run() {
	env := h.env

	env.OnActivity(acts.ListAutoTickets, mock.Anything).
		Return(func(context.Context) ([]work.Ticket, error) {
			return h.tickets, h.listErr
		})

	env.OnActivity(acts.DescribeRun, mock.Anything, mock.Anything).
		Return(func(_ context.Context, workflowID string) (work.RunState, error) {
			h.described = append(h.described, workflowID)
			return h.runs[workflowID], nil
		})

	env.OnActivity(acts.SweepOrphanSandboxes, mock.Anything, mock.Anything).
		Return(func(_ context.Context, in activities.SweepInput) (activities.SweepResult, error) {
			h.sweeps = append(h.sweeps, in)
			return activities.SweepResult{}, h.sweepErr
		})

	// Starting a run makes that ticket's workflow open, which is what a
	// reconcile a moment later will find. The child itself is a stub: this is a
	// test of the dispatcher, and a real child would free its own slot and hide
	// what the dispatcher decided.
	env.OnWorkflow(workflows.WorkTicket, mock.Anything, mock.Anything).
		Return(func(_ workflow.Context, in workflows.WorkTicketInput) (workflows.WorkTicketResult, error) {
			h.started = append(h.started, in.Ticket.Number)
			h.runs[work.WorkflowID(in.Ticket.Number)] = work.RunState{Open: true, RunID: "child-run"}
			return workflows.WorkTicketResult{Outcome: work.OutcomeProposed}, nil
		})

	if h.historyLength > 0 {
		env.SetCurrentHistoryLength(h.historyLength)
	}
	for _, c := range h.callbacks {
		env.RegisterDelayedCallback(c.fn, c.at)
	}
	if h.runFor > 0 {
		env.RegisterDelayedCallback(env.CancelWorkflow, h.runFor)
	}

	env.ExecuteWorkflow(workflows.Dispatcher, workflows.DispatcherInput{
		Config:   h.config,
		Tuning:   h.tuning,
		Run:      work.DefaultRunPolicy(),
		InFlight: h.inFlight,
		Breaker:  h.breaker,
	})
}

// status queries the dispatcher the way a human would.
func (h *dispatcherHarness) status(t *testing.T) work.Status {
	t.Helper()
	val, err := h.env.QueryWorkflow(workflows.QueryStatus)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	var status work.Status
	if err := val.Get(&status); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	return status
}

// continuedInput is the state the dispatcher carried into its next run.
func (h *dispatcherHarness) continuedInput(t *testing.T) workflows.DispatcherInput {
	t.Helper()
	err := h.env.GetWorkflowError()
	var can *workflow.ContinueAsNewError
	if !errors.As(err, &can) {
		t.Fatalf("the dispatcher did not continue as new: %v", err)
	}
	var in workflows.DispatcherInput
	if err := converter.GetDefaultDataConverter().FromPayloads(can.Input, &in); err != nil {
		t.Fatalf("decode carried state: %v", err)
	}
	return in
}

func tickets(numbers ...int) []work.Ticket {
	out := make([]work.Ticket, 0, len(numbers))
	for _, n := range numbers {
		out = append(out, work.Ticket{Number: n, Title: "t", Body: "b"})
	}
	return out
}

func TestDispatcherStartsUpToTheConcurrencyCapAndNoMore(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.tickets = tickets(1, 2, 3, 4)
	h.run()

	if len(h.started) != 2 {
		t.Fatalf("started %v, want 2 — the cap is the whole of the concurrency control", h.started)
	}
}

func TestDispatcherStartsNothingMoreWhileTheCapIsFull(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.inFlight = []work.InFlightTicket{{Ticket: 1, RunID: "run-1"}, {Ticket: 2, RunID: "run-2"}}
	h.runs["work-ticket-1"] = work.RunState{Open: true, RunID: "run-1"}
	h.runs["work-ticket-2"] = work.RunState{Open: true, RunID: "run-2"}
	h.tickets = tickets(1, 2, 3)
	h.run()

	if len(h.started) != 0 {
		t.Fatalf("started %v, want none", h.started)
	}
}

func TestDispatcherReleasesTheSlotOfARunThatDiedWithoutSaying(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.inFlight = []work.InFlightTicket{{Ticket: 1, RunID: "run-1"}, {Ticket: 2, RunID: "run-2"}}
	h.runs["work-ticket-1"] = work.RunState{Open: true, RunID: "run-1"}
	h.runs["work-ticket-2"] = work.RunState{} // closed: nobody signalled.
	h.tickets = tickets(3)
	h.run()

	if len(h.started) != 1 || h.started[0] != 3 {
		t.Fatalf("started %v, want ticket 3 — a run that died without signalling holds its slot forever otherwise", h.started)
	}
}

func TestDispatcherReleasesTheSlotWhenAChildReportsItFinished(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.config.MaxInFlight = 1
	h.inFlight = []work.InFlightTicket{{Ticket: 1, RunID: "run-1"}}
	h.runs["work-ticket-1"] = work.RunState{Open: true, RunID: "run-1"}
	h.tickets = tickets(1, 2)
	h.at(45*time.Second, func() {
		h.runs["work-ticket-1"] = work.RunState{}
		h.tickets = tickets(2)
		h.env.SignalWorkflow(workflows.SignalTicketDone, work.TicketDone{
			Ticket: 1, RunID: "run-1", Outcome: work.OutcomeProposed,
		})
	})
	h.run()

	if len(h.started) != 1 || h.started[0] != 2 {
		t.Fatalf("started %v, want ticket 2 once the slot was freed", h.started)
	}
}

func TestDispatcherIgnoresACompletionReportFromARunItHasAlreadyReplaced(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.config.MaxInFlight = 1
	h.inFlight = []work.InFlightTicket{{Ticket: 1, RunID: "run-2"}}
	h.runs["work-ticket-1"] = work.RunState{Open: true, RunID: "run-2"}
	// Ticket 1 is deliberately not listed: if the stale report freed its slot,
	// the dispatcher would simply re-adopt the run it still has, and the bug
	// would be invisible. Ticket 9 is what a wrongly-freed slot would start.
	h.tickets = tickets(9)
	h.at(45*time.Second, func() {
		h.env.SignalWorkflow(workflows.SignalTicketDone, work.TicketDone{
			Ticket: 1, RunID: "run-1", Outcome: work.OutcomeFailed, Failure: work.FailureOther,
		})
	})
	h.run()

	if len(h.started) != 0 {
		t.Fatalf("started %v — a stale report from a superseded run must not free the current run's slot", h.started)
	}
}

func TestDispatcherAdoptsARunItHasForgottenRatherThanStartingASecond(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.config.MaxInFlight = 2
	h.tickets = tickets(1, 2, 3)
	// Ticket 1 is already being worked by a run this dispatcher does not know
	// about — the state after a restart, or after a lost ContinueAsNew.
	h.runs["work-ticket-1"] = work.RunState{Open: true, RunID: "run-older"}
	h.run()

	for _, n := range h.started {
		if n == 1 {
			t.Fatal("ticket 1 already has a run; starting a second is the double-work workflow-ID uniqueness exists to prevent")
		}
	}
	if len(h.started) != 1 {
		t.Fatalf("started %v, want exactly one — the adopted run must count against the cap", h.started)
	}
	status := h.status(t)
	if len(status.InFlight) != 2 {
		t.Fatalf("in flight %+v, want the adopted run and the started one", status.InFlight)
	}
}

func TestDispatcherPausesWhenItsOwnActivityReportsAnAuthFailure(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.tickets = tickets(1, 2)
	h.listErr = temporal.NewNonRetryableApplicationError("revoked", activities.ErrTypeAuth, nil)
	h.run()

	status := h.status(t)
	if !status.Config.Paused {
		t.Fatal("a revoked credential must stop the system, not be retried every poll forever")
	}
	if status.Config.PauseReason == "" {
		t.Fatal("a paused system must say why, or the only way to find out is reading logs")
	}
	if len(h.started) != 0 {
		t.Fatalf("started %v while its credential was dead", h.started)
	}
}

func TestDispatcherPausesWhenAChildReportsAnAuthFailure(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.config.MaxInFlight = 1
	h.inFlight = []work.InFlightTicket{{Ticket: 1, RunID: "run-1"}}
	h.runs["work-ticket-1"] = work.RunState{Open: true, RunID: "run-1"}
	h.tickets = tickets(1, 2)
	h.at(45*time.Second, func() {
		h.runs["work-ticket-1"] = work.RunState{}
		h.tickets = tickets(2)
		h.env.SignalWorkflow(workflows.SignalTicketDone, work.TicketDone{
			Ticket: 1, RunID: "run-1", Outcome: work.OutcomeFailed,
			Failure: work.FailureAuth, Detail: "the auto label could not be removed",
		})
	})
	h.run()

	status := h.status(t)
	if !status.Config.Paused {
		t.Fatal("a ticket whose auto label cannot be removed is re-listed every poll forever unless this pauses (#333, #339)")
	}
	if len(h.started) != 0 {
		t.Fatalf("started %v after pausing", h.started)
	}
}

func TestDispatcherStartsNothingWhilePaused(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.config.Paused = true

	h.tickets = tickets(1, 2)
	h.run()

	if len(h.started) != 0 {
		t.Fatalf("started %v while paused", h.started)
	}
}

func TestDispatcherKeepsWorkingTicketsItHasAlreadyStartedWhenItPauses(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.config.Paused = true
	h.inFlight = []work.InFlightTicket{{Ticket: 1, RunID: "run-1"}}
	h.runs["work-ticket-1"] = work.RunState{Open: true, RunID: "run-1"}
	h.run()

	status := h.status(t)
	if len(status.InFlight) != 1 {
		t.Fatal("pausing is about what the system takes on; killing work already paid for is a louder act than a config field")
	}
}

func TestDispatcherTripsTheBreakerOnARateLimitAndWaitsOutTheCooldown(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.config.MaxInFlight = 1
	h.config.BreakerCooldownSeconds = int64((10 * time.Minute).Seconds())
	h.inFlight = []work.InFlightTicket{{Ticket: 1, RunID: "run-1"}}
	h.runs["work-ticket-1"] = work.RunState{Open: true, RunID: "run-1"}
	h.tickets = tickets(1, 2)
	h.runFor = 5 * time.Minute
	h.at(45*time.Second, func() {
		h.runs["work-ticket-1"] = work.RunState{}
		h.tickets = tickets(2)
		h.env.SignalWorkflow(workflows.SignalTicketDone, work.TicketDone{
			Ticket: 1, RunID: "run-1", Outcome: work.OutcomeFailed, Failure: work.FailureRateLimit,
		})
	})
	h.run()

	if len(h.started) != 0 {
		t.Fatalf("started %v inside the cooldown — every in-flight ticket would burn its retries into the same wall", h.started)
	}
	status := h.status(t)
	if !status.Breaker.OpenAt(h.env.Now()) || status.Config.Paused {
		t.Fatalf("status = %+v, want an open breaker and no pause: a rate limit is a wait, not a dead system", status)
	}
}

func TestDispatcherStartsAgainOnceTheCooldownElapses(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.config.MaxInFlight = 1
	h.config.BreakerCooldownSeconds = int64((2 * time.Minute).Seconds())
	h.tickets = tickets(2)
	h.breaker = work.Breaker{Reason: "rate limited"}
	h.runFor = 10 * time.Minute
	h.at(time.Second, func() {
		h.env.SignalWorkflow(workflows.SignalTicketDone, work.TicketDone{
			Ticket: 1, RunID: "run-1", Outcome: work.OutcomeFailed, Failure: work.FailureRateLimit,
		})
	})
	h.run()

	if len(h.started) != 1 {
		t.Fatalf("started %v, want ticket 2 after the cooldown — the breaker is a wait, not a stop", h.started)
	}
}

func TestDispatcherAppliesAConfigUpdate(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.tickets = tickets(1, 2, 3, 4)
	h.config.MaxInFlight = 1
	h.at(45*time.Second, func() {
		concurrency := 3
		h.env.SignalWorkflow(workflows.SignalUpdateConfig, work.ConfigUpdate{MaxInFlight: &concurrency})
	})
	h.run()

	if len(h.started) != 3 {
		t.Fatalf("started %v, want 3 after the cap was raised", h.started)
	}
	if got := h.status(t).Config.MaxInFlight; got != 3 {
		t.Fatalf("max in flight = %d, want 3", got)
	}
}

func TestDispatcherKeepsRunningOnAConfigUpdateItCannotUse(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.tickets = tickets(1, 2, 3)
	h.at(45*time.Second, func() {
		zero := 0
		h.env.SignalWorkflow(workflows.SignalUpdateConfig, work.ConfigUpdate{MaxInFlight: &zero})
	})
	h.run()

	if got := h.status(t).Config.MaxInFlight; got != 2 {
		t.Fatalf("max in flight = %d, want the previous value — a bad update is discarded, not adopted, and not fatal", got)
	}
	if h.env.IsWorkflowCompleted() && !temporal.IsCanceledError(h.env.GetWorkflowError()) {
		t.Fatalf("a bad update must not end the dispatcher: %v", h.env.GetWorkflowError())
	}
}

func TestDispatcherUnpausesOnAConfigUpdate(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.config.Paused = true

	h.tickets = tickets(1)
	h.at(45*time.Second, func() {
		resumed := false
		h.env.SignalWorkflow(workflows.SignalUpdateConfig, work.ConfigUpdate{Paused: &resumed})
	})
	h.run()

	if len(h.started) != 1 {
		t.Fatalf("started %v, want the dispatcher to resume — pause and resume are one config field", h.started)
	}
}

func TestDispatcherReportsWhatItIsWorkingAndWhyItIsNotWorkingMore(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.tickets = tickets(1)
	h.run()

	status := h.status(t)
	if len(status.InFlight) != 1 || status.InFlight[0] != 1 {
		t.Fatalf("in flight = %+v, want ticket 1", status.InFlight)
	}
}

func TestDispatcherContinuesAsNewCarryingEverythingItKnows(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.tuning.MaxHistoryEvents = 1
	h.historyLength = 100
	h.config.MaxInFlight = 1
	h.tickets = tickets(1)
	h.breaker = work.Breaker{Reason: "earlier rate limit"}
	h.runFor = 0
	h.run()

	in := h.continuedInput(t)
	if len(in.InFlight) != 1 || in.InFlight[0].Ticket != 1 || in.InFlight[0].RunID == "" {
		t.Fatalf("carried %+v — a dropped in-flight set means the cap is enforced against nothing", in.InFlight)
	}
	if in.Config.MaxInFlight != 1 {
		t.Fatalf("carried config %+v, want the running config, not the defaults", in.Config)
	}
	if in.Tuning.MaxHistoryEvents != h.tuning.MaxHistoryEvents || in.Run.StageTimeout == 0 {
		t.Fatalf("carried tuning %+v and policy %+v — deploy-time settings must survive a run boundary too",
			in.Tuning, in.Run)
	}
	if in.Breaker.Reason != "earlier rate limit" {
		t.Fatalf("carried breaker %+v — a breaker reset by ContinueAsNew is a breaker that never trips", in.Breaker)
	}
}

func TestDispatcherDrainsSignalsThatArriveAsItContinuesAsNew(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.tuning.MaxHistoryEvents = 1
	h.historyLength = 100
	h.tickets = nil
	h.runFor = 0
	h.at(time.Nanosecond, func() {
		paused := true
		h.env.SignalWorkflow(workflows.SignalUpdateConfig, work.ConfigUpdate{Paused: &paused})
	})
	h.run()

	in := h.continuedInput(t)
	if !in.Config.Paused {
		t.Fatal("a signal that arrived in the tick that continued as new must be drained into the carried state, not lost with the run")
	}
}

func TestDispatcherSweepsOrphanedSandboxesNamingTheRunsThatMustSurvive(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.config.OrphanGraceSeconds = int64((30 * time.Minute).Seconds())
	h.inFlight = []work.InFlightTicket{{Ticket: 1, RunID: "run-1"}}
	h.runs["work-ticket-1"] = work.RunState{Open: true, RunID: "run-1"}
	h.run()

	if len(h.sweeps) == 0 {
		t.Fatal("nothing else in the system can delete the pod of a worker that died mid-ticket (#334)")
	}
	sweep := h.sweeps[0]
	if len(sweep.LiveRunIDs) != 1 || sweep.LiveRunIDs[0] != "run-1" {
		t.Fatalf("swept with live runs %v, want the in-flight run", sweep.LiveRunIDs)
	}
	if sweep.MinAge != 30*time.Minute {
		t.Fatalf("swept with a floor of %s, want the configured grace", sweep.MinAge)
	}
}

func TestDispatcherDoesNotSweepOnEveryPoll(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.config.PollIntervalSeconds = 30
	h.config.OrphanGraceSeconds = int64((30 * time.Minute).Seconds())
	h.runFor = 5 * time.Minute
	h.run()

	if len(h.sweeps) != 1 {
		t.Fatalf("swept %d times in five minutes — the sweep is reconciliation, not the poll loop", len(h.sweeps))
	}
}

func TestDispatcherRefusesAConfigItCannotRunOn(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.config.PollIntervalSeconds = 0
	h.runFor = 0
	h.run()

	err := h.env.GetWorkflowError()
	var app *temporal.ApplicationError
	if !errors.As(err, &app) || !app.NonRetryable() {
		t.Fatalf("a dispatcher with no poll interval must fail loudly at start, got %v", err)
	}
}

func TestDispatcherReportsARejectedConfigUpdateBackThroughItsStatus(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.at(45*time.Second, func() {
		zero := 0
		h.env.SignalWorkflow(workflows.SignalUpdateConfig, work.ConfigUpdate{MaxInFlight: &zero})
	})
	h.run()

	status := h.status(t)
	if status.ConfigError == "" {
		t.Fatal("a Temporal signal cannot fail back to its sender, so an update that was rejected and one that " +
			"was applied are indistinguishable unless the dispatcher says so through GetStatus")
	}
	if !strings.Contains(status.ConfigError, "MaxInFlight") {
		t.Fatalf("ConfigError = %q — it must name what was wrong, not merely that something was", status.ConfigError)
	}
}

func TestDispatcherClearsTheConfigErrorOnceAGoodUpdateLands(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.at(30*time.Second, func() {
		zero := 0
		h.env.SignalWorkflow(workflows.SignalUpdateConfig, work.ConfigUpdate{MaxInFlight: &zero})
	})
	h.at(60*time.Second, func() {
		three := 3
		h.env.SignalWorkflow(workflows.SignalUpdateConfig, work.ConfigUpdate{MaxInFlight: &three})
	})
	h.run()

	status := h.status(t)
	if status.ConfigError != "" {
		t.Fatalf("ConfigError = %q — a stale complaint outliving the mistake sends an operator after a "+
			"problem they already fixed", status.ConfigError)
	}
	if status.Config.MaxInFlight != 3 {
		t.Fatalf("max in flight = %d, want the update that succeeded", status.Config.MaxInFlight)
	}
}

func TestDispatcherCarriesARejectedUpdateAcrossAContinueAsNew(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.tuning.MaxHistoryEvents = 1
	h.historyLength = 100
	h.runFor = 0
	h.at(time.Nanosecond, func() {
		zero := 0
		h.env.SignalWorkflow(workflows.SignalUpdateConfig, work.ConfigUpdate{MaxInFlight: &zero})
	})
	h.run()

	if in := h.continuedInput(t); in.ConfigError == "" {
		t.Fatal("an operator reading GetStatus after a run boundary would see their rejected update turn into silence")
	}
}

func TestDispatcherSaysWhyItPausedItself(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.tickets = tickets(1)
	h.listErr = temporal.NewNonRetryableApplicationError("installation revoked", activities.ErrTypeAuth, nil)
	h.run()

	status := h.status(t)
	if !status.Config.Paused {
		t.Fatal("a revoked credential must pause the dispatcher")
	}
	if status.Config.PauseReason == "" {
		t.Fatal("Paused alone cannot tell a dispatcher that stopped itself on a dead credential from a human " +
			"pausing it deliberately — opposite responses, and the difference is invisible without a reason")
	}
}

func TestDispatcherForgetsWhyItPausedWhenAHumanResumesIt(t *testing.T) {
	t.Parallel()

	h := newDispatcherHarness(t)
	h.config.Paused = true
	h.config.PauseReason = "github refused this app's credentials"
	h.tickets = tickets(1)
	h.at(45*time.Second, func() {
		resumed := false
		h.env.SignalWorkflow(workflows.SignalUpdateConfig, work.ConfigUpdate{Paused: &resumed})
	})
	h.run()

	if reason := h.status(t).Config.PauseReason; reason != "" {
		t.Fatalf("PauseReason = %q — GetStatus must not explain a pause that is over", reason)
	}
}

func TestDispatcherReconcilesInAFixedOrderSoAReplayMatches(t *testing.T) {
	t.Parallel()

	// Go randomises map iteration, and a workflow that scheduled activities in
	// a different order on replay is corrupt — a failure that shows up days
	// later as a broken run, never as a failed build. Eight tickets make an
	// unsorted implementation escape with probability 1/8!, about 1 in 40,000.
	const tickets = 8
	h := newDispatcherHarness(t)
	h.config.MaxInFlight = tickets
	for n := 1; n <= tickets; n++ {
		id := fmt.Sprintf("run-%d", n)
		h.inFlight = append(h.inFlight, work.InFlightTicket{Ticket: n, RunID: id})
		h.runs[work.WorkflowID(n)] = work.RunState{Open: true, RunID: id}
	}
	h.runFor = 45 * time.Second
	h.run()

	if len(h.described) < tickets {
		t.Fatalf("reconciled %d of %d tickets", len(h.described), tickets)
	}
	for i, wantTicket := 0, 1; wantTicket <= tickets; i, wantTicket = i+1, wantTicket+1 {
		if want := work.WorkflowID(wantTicket); h.described[i] != want {
			t.Fatalf("reconciled %v — the in-flight set must be walked in a fixed order, not map order",
				h.described[:tickets])
		}
	}
}
