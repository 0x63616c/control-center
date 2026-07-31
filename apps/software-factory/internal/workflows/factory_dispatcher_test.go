package workflows_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
	"github.com/stretchr/testify/mock"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"
)

// ticketActs is a nil handle used only to name activity methods for the test
// environment's mocks, the same pattern acts (workticket_test.go) uses for
// *activities.Activities. factory_workticket_test.go registers real
// RecordingActivities and TranscriptRecordingActivities against a
// storefake.Store instead of mocking them, so it needs no nil handle of its
// own.
var ticketActs *activities.TicketActivities

// factoryDispatcherHarness runs FactoryDispatcher against fakes — the same
// harness shape dispatcherHarness (dispatcher_test.go) uses for Dispatcher,
// pared down to what the Ticket-backed loop actually needs: no breaker, no
// config-update signal, no `auto` label (see FactoryDispatcherInput's own
// doc comment for why those are out of scope here).
type factoryDispatcherHarness struct {
	env *testsuite.TestWorkflowEnvironment

	config        work.Config
	tuning        work.DispatcherTuning
	inFlight      []store.InFlightTicket
	tickets       []store.Ticket
	listErr       error
	runs          map[string]work.RunState
	sweepErr      error
	historyLength int
	runFor        time.Duration
	callbacks     []delayedFactoryCallback

	started []store.TicketID
	sweeps  []activities.SweepInput
}

type delayedFactoryCallback struct {
	at time.Duration
	fn func()
}

func newFactoryDispatcherHarness(t *testing.T) *factoryDispatcherHarness {
	t.Helper()
	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestWorkflowEnvironment()
	env.SetDetachedChildWait(false)

	tuning := work.DefaultDispatcherTuning()
	tuning.MaxHistoryEvents = 1_000_000

	return &factoryDispatcherHarness{
		env:    env,
		config: work.DefaultFactoryConfig(),
		tuning: tuning,
		runs:   map[string]work.RunState{},
		runFor: 90 * time.Second,
	}
}

func (h *factoryDispatcherHarness) at(d time.Duration, fn func()) {
	h.callbacks = append(h.callbacks, delayedFactoryCallback{at: d, fn: fn})
}

func (h *factoryDispatcherHarness) run() {
	env := h.env

	// The test environment does not grow GetCurrentHistoryLength() on its
	// own — a real workflow's history grows as commands and events accrue,
	// but nothing here replays against a real history. SetCurrentHistoryLength
	// is how a continue-as-new test forces the threshold, the same fake
	// dispatcherHarness (dispatcher_test.go) uses.
	if h.historyLength > 0 {
		env.SetCurrentHistoryLength(h.historyLength)
	}

	env.OnActivity(ticketActs.ListReadyTickets, mock.Anything).
		Return(func(context.Context) ([]store.Ticket, error) { return h.tickets, h.listErr })

	env.OnActivity(acts.DescribeRun, mock.Anything, mock.Anything).
		Return(func(_ context.Context, workflowID string) (work.RunState, error) { return h.runs[workflowID], nil })

	env.OnActivity(acts.SweepOrphanSandboxes, mock.Anything, mock.Anything).
		Return(func(_ context.Context, in activities.SweepInput) (activities.SweepResult, error) {
			h.sweeps = append(h.sweeps, in)
			return activities.SweepResult{}, h.sweepErr
		})

	// Starting a run makes that Ticket's workflow open, exactly the same
	// stub-child shape dispatcherHarness uses: this is a test of the
	// dispatcher's own decisions, and a real child would hide them.
	env.OnWorkflow(workflows.FactoryWorkTicket, mock.Anything, mock.Anything).
		Return(func(_ workflow.Context, in workflows.FactoryWorkTicketInput) (workflows.FactoryWorkTicketResult, error) {
			h.started = append(h.started, in.TicketID)
			h.runs[work.FactoryTicketWorkflowID(int64(in.TicketID))] = work.RunState{Open: true, RunID: "child-run"}
			return workflows.FactoryWorkTicketResult{Outcome: work.OutcomeProposed}, nil
		})

	for _, c := range h.callbacks {
		env.RegisterDelayedCallback(c.fn, c.at)
	}
	if h.runFor > 0 {
		env.RegisterDelayedCallback(env.CancelWorkflow, h.runFor)
	}

	in := workflows.FactoryDispatcherInput{
		Config: h.config, Tuning: h.tuning, Run: work.DefaultRunPolicy(), InFlight: h.inFlight,
	}
	env.ExecuteWorkflow(workflows.FactoryDispatcher, in)
}

func (h *factoryDispatcherHarness) continuedInput(t *testing.T) workflows.FactoryDispatcherInput {
	t.Helper()
	err := h.env.GetWorkflowError()
	var can *workflow.ContinueAsNewError
	if !errors.As(err, &can) {
		t.Fatalf("the factory dispatcher did not continue as new: %v", err)
	}
	var in workflows.FactoryDispatcherInput
	if err := converter.GetDefaultDataConverter().FromPayloads(can.Input, &in); err != nil {
		t.Fatalf("decode carried state: %v", err)
	}
	return in
}

func readyTickets(ids ...int64) []store.Ticket {
	out := make([]store.Ticket, 0, len(ids))
	for _, id := range ids {
		out = append(out, store.Ticket{ID: store.TicketID(id), Title: "t", Body: "b", State: store.TicketOpen})
	}
	return out
}

func TestFactoryDispatcherStartsUpToItsCapAndNoMore(t *testing.T) {
	t.Parallel()

	h := newFactoryDispatcherHarness(t)
	h.config.MaxInFlight = 2
	h.tickets = readyTickets(1, 2, 3, 4)
	h.run()

	if len(h.started) != 2 {
		t.Fatalf("started %v, want 2 — the cap is the whole of the concurrency control", h.started)
	}
}

func TestFactoryDispatcherDefaultsToOneInFlightBecauseTheCodexQuotaIsShared(t *testing.T) {
	t.Parallel()

	h := newFactoryDispatcherHarness(t)
	// h.config is already work.DefaultFactoryConfig() from newFactoryDispatcherHarness.
	h.tickets = readyTickets(1, 2, 3)
	h.run()

	if len(h.started) != 1 {
		t.Fatalf("started %v, want exactly 1 under the default factory config", h.started)
	}
}

func TestFactoryDispatcherStartsNothingMoreWhileTheCapIsFull(t *testing.T) {
	t.Parallel()

	h := newFactoryDispatcherHarness(t)
	h.config.MaxInFlight = 1
	h.inFlight = []store.InFlightTicket{{TicketID: 1, RunID: "run-1"}}
	h.runs[work.FactoryTicketWorkflowID(1)] = work.RunState{Open: true, RunID: "run-1"}
	h.tickets = readyTickets(1, 2)
	h.run()

	if len(h.started) != 0 {
		t.Fatalf("started %v, want none — the one slot is already taken", h.started)
	}
}

func TestFactoryDispatcherReconcileFreesASlotWhoseRunHasClosed(t *testing.T) {
	t.Parallel()

	h := newFactoryDispatcherHarness(t)
	h.config.MaxInFlight = 1
	h.inFlight = []store.InFlightTicket{{TicketID: 1, RunID: "run-1"}}
	h.runs[work.FactoryTicketWorkflowID(1)] = work.RunState{Open: false}
	h.tickets = readyTickets(2)
	h.run()

	if got, want := h.started, []store.TicketID{2}; len(got) != 1 || got[0] != want[0] {
		t.Fatalf("started %v, want [2] — reconcile must have freed ticket 1's slot first", got)
	}
}

func TestFactoryDispatcherCompletionSignalFreesASlotWithoutWaitingForReconcile(t *testing.T) {
	t.Parallel()

	h := newFactoryDispatcherHarness(t)
	h.config.MaxInFlight = 1
	h.inFlight = []store.InFlightTicket{{TicketID: 1, RunID: "run-1"}}
	// Deliberately no h.runs entry for ticket 1: if reconcile were what freed
	// the slot, DescribeRun would report a zero RunState (Open: false) too and
	// this test would not distinguish the signal from the backstop. Give it a
	// RunState that looks very much still open, so only the signal explains a
	// second ticket starting.
	h.runs[work.FactoryTicketWorkflowID(1)] = work.RunState{Open: true, RunID: "run-1"}
	h.tickets = readyTickets(2)
	h.at(0, func() {
		h.env.SignalWorkflow(workflows.SignalFactoryTicketDone, workflows.FactoryTicketDone{TicketID: 1, RunID: "run-1"})
	})
	h.run()

	if got, want := h.started, []store.TicketID{2}; len(got) != 1 || got[0] != want[0] {
		t.Fatalf("started %v, want [2] — the completion signal must free ticket 1's slot immediately", got)
	}
}

func TestFactoryDispatcherIgnoresACompletionSignalForARunItNoLongerBelievesIsCurrent(t *testing.T) {
	t.Parallel()

	h := newFactoryDispatcherHarness(t)
	h.config.MaxInFlight = 1
	h.inFlight = []store.InFlightTicket{{TicketID: 1, RunID: "run-current"}}
	h.runs[work.FactoryTicketWorkflowID(1)] = work.RunState{Open: true, RunID: "run-current"}
	h.tickets = readyTickets(2)
	// A stale signal from an earlier, already-superseded run of ticket 1 must
	// not free the slot the CURRENT run of ticket 1 holds.
	h.at(0, func() {
		h.env.SignalWorkflow(workflows.SignalFactoryTicketDone, workflows.FactoryTicketDone{TicketID: 1, RunID: "run-stale"})
	})
	h.run()

	if len(h.started) != 0 {
		t.Fatalf("started %v, want none — a stale completion signal must not free the current run's slot", h.started)
	}
}

func TestFactoryDispatcherSweepsOrphanSandboxesAgainstOnlyItsOwnLiveRuns(t *testing.T) {
	t.Parallel()

	h := newFactoryDispatcherHarness(t)
	h.config.MaxInFlight = 1
	h.inFlight = []store.InFlightTicket{{TicketID: 1, RunID: "run-1"}}
	h.runs[work.FactoryTicketWorkflowID(1)] = work.RunState{Open: true, RunID: "run-1"}
	h.run()

	if len(h.sweeps) == 0 {
		t.Fatal("no sweep ran")
	}
	if got, want := h.sweeps[0].LiveRunIDs, []string{"run-1"}; len(got) != 1 || got[0] != want[0] {
		t.Fatalf("sweep live run ids = %v, want %v", got, want)
	}
}

func TestFactoryDispatcherRefusesAnInvalidConfig(t *testing.T) {
	t.Parallel()

	h := newFactoryDispatcherHarness(t)
	h.config.MaxInFlight = 0
	h.run()

	err := h.env.GetWorkflowError()
	if err == nil {
		t.Fatal("want an error for an invalid config, got none")
	}
	var appErr *temporal.ApplicationError
	if !errors.As(err, &appErr) || appErr.Type() != activities.ErrTypeInvalid {
		t.Fatalf("error = %v, want a non-retryable %s application error", err, activities.ErrTypeInvalid)
	}
}

func TestFactoryDispatcherCarriesInFlightAcrossContinueAsNew(t *testing.T) {
	t.Parallel()

	h := newFactoryDispatcherHarness(t)
	h.config.MaxInFlight = 1
	h.tuning.MaxHistoryEvents = 1
	h.historyLength = 100
	h.inFlight = []store.InFlightTicket{{TicketID: 7, RunID: "run-7"}}
	h.runs[work.FactoryTicketWorkflowID(7)] = work.RunState{Open: true, RunID: "run-7"}
	h.runFor = 0
	h.run()

	next := h.continuedInput(t)
	if len(next.InFlight) != 1 || next.InFlight[0].TicketID != 7 {
		t.Fatalf("continued InFlight = %+v, want ticket 7 carried forward", next.InFlight)
	}
}

// TestFactoryDispatcherAppliesAnUpdateConfigSignal is the control surface the
// factory has left once the GitHub-backed dispatcher is gone (#559): there is
// no DISPATCHER_CONFIG environment variable behind this dispatcher, so pausing
// it, resuming it and changing its cap are the UpdateConfig signal or nothing.
func TestFactoryDispatcherAppliesAnUpdateConfigSignal(t *testing.T) {
	t.Parallel()

	h := newFactoryDispatcherHarness(t)
	h.config.MaxInFlight = 2
	h.config.Paused = true
	h.tickets = readyTickets(1, 2)
	resume := false
	h.at(45*time.Second, func() {
		h.env.SignalWorkflow(workflows.SignalUpdateConfig, work.ConfigUpdate{Paused: &resume})
	})
	h.run()

	if len(h.started) != 2 {
		t.Fatalf("started %v, want 2 — the resume signal must reach a paused dispatcher", h.started)
	}
}

// TestFactoryDispatcherRefusesAnUnusableUpdateWhole proves a bad update is
// refused entire rather than partly adopted: work.Config.Apply validates the
// result, so a message that also carries a cap above the ceiling must not
// unpause the dispatcher on its way to being rejected.
func TestFactoryDispatcherRefusesAnUnusableUpdateWhole(t *testing.T) {
	t.Parallel()

	h := newFactoryDispatcherHarness(t)
	h.config.MaxInFlight = 2
	h.config.Paused = true
	h.tickets = readyTickets(1, 2, 3)
	resume := false
	absurd := 11 // above work's ceiling of 10
	h.at(45*time.Second, func() {
		h.env.SignalWorkflow(workflows.SignalUpdateConfig,
			work.ConfigUpdate{Paused: &resume, MaxInFlight: &absurd})
	})
	h.run()

	if len(h.started) != 0 {
		t.Fatalf("started %v, want none — an update that fails validation must be refused whole, unpause included", h.started)
	}
}
