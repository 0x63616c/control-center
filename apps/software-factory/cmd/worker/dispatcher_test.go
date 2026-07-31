package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"reflect"
	"testing"

	"go.temporal.io/sdk/client"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
)

// fakeWorkflowRun is the minimal client.WorkflowRun a test needs: an ID pair,
// nothing else. ensureFactoryDispatcher never calls Get.
type fakeWorkflowRun struct {
	id, runID string
}

func (f fakeWorkflowRun) GetID() string    { return f.id }
func (f fakeWorkflowRun) GetRunID() string { return f.runID }

func (f fakeWorkflowRun) Get(context.Context, interface{}) error {
	panic("ensureFactoryDispatcher must not block on the dispatcher's result: it never returns")
}

func (f fakeWorkflowRun) GetWithOptions(context.Context, interface{}, client.WorkflowRunGetOptions) error {
	panic("not used by ensureFactoryDispatcher")
}

// fakeStarter records what ensureFactoryDispatcher asked Temporal to start.
type fakeStarter struct {
	gotOptions  client.StartWorkflowOptions
	gotWorkflow interface{}
	gotArgs     []interface{}

	run client.WorkflowRun
	err error
}

func (f *fakeStarter) ExecuteWorkflow(
	_ context.Context, options client.StartWorkflowOptions, workflow interface{}, args ...interface{},
) (client.WorkflowRun, error) {
	f.gotOptions, f.gotWorkflow, f.gotArgs = options, workflow, args
	return f.run, f.err
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestEnsureFactoryDispatcherStartsOnTheOneDispatcherWorkflowID(t *testing.T) {
	t.Parallel()

	fake := &fakeStarter{run: fakeWorkflowRun{id: work.FactoryDispatcherWorkflowID, runID: "run-1"}}

	if err := ensureFactoryDispatcher(context.Background(), fake, discardLogger()); err != nil {
		t.Fatalf("ensureFactoryDispatcher: %v", err)
	}

	if fake.gotOptions.ID != work.FactoryDispatcherWorkflowID {
		t.Errorf("StartWorkflowOptions.ID = %q, want %q", fake.gotOptions.ID, work.FactoryDispatcherWorkflowID)
	}
	if fake.gotOptions.TaskQueue != work.TaskQueue {
		t.Errorf("StartWorkflowOptions.TaskQueue = %q, want %q", fake.gotOptions.TaskQueue, work.TaskQueue)
	}
	// A worker replica racing another to start this must not error: the
	// default WorkflowExecutionErrorWhenAlreadyStarted (false) is what makes
	// ExecuteWorkflow attach instead of failing, and setting it explicitly
	// here would be the one line that turns every second replica's boot into
	// a startup failure.
	if fake.gotOptions.WorkflowExecutionErrorWhenAlreadyStarted {
		t.Error("WorkflowExecutionErrorWhenAlreadyStarted = true, want false: a second replica attaching to the running dispatcher must not error")
	}
	if reflect.ValueOf(fake.gotWorkflow).Pointer() != reflect.ValueOf(workflows.FactoryDispatcher).Pointer() {
		t.Error("ExecuteWorkflow was not called with workflows.FactoryDispatcher")
	}
}

// TestEnsureFactoryDispatcherStartsOnTheDefaultFactoryConfig proves the config
// this call carries is the one the dispatcher would start on, in case this is
// the boot that actually starts the workflow. It is ignored by Temporal on
// every other boot — the running dispatcher carries its config in workflow
// state, and a live change is the UpdateConfig signal the API sends — but this
// call must offer it regardless, since there is no way to know in advance
// which boot that is.
func TestEnsureFactoryDispatcherStartsOnTheDefaultFactoryConfig(t *testing.T) {
	t.Parallel()

	fake := &fakeStarter{run: fakeWorkflowRun{}}

	if err := ensureFactoryDispatcher(context.Background(), fake, discardLogger()); err != nil {
		t.Fatalf("ensureFactoryDispatcher: %v", err)
	}

	if len(fake.gotArgs) != 1 {
		t.Fatalf("ExecuteWorkflow got %d args, want 1 (the FactoryDispatcherInput)", len(fake.gotArgs))
	}
	in, ok := fake.gotArgs[0].(workflows.FactoryDispatcherInput)
	if !ok {
		t.Fatalf("ExecuteWorkflow arg[0] is %T, want workflows.FactoryDispatcherInput", fake.gotArgs[0])
	}
	if in.Config != work.DefaultFactoryConfig() {
		t.Errorf("FactoryDispatcherInput.Config = %+v, want the default factory config", in.Config)
	}
	if in.Tuning.MaxHistoryEvents != work.DefaultDispatcherTuning().MaxHistoryEvents {
		t.Errorf("FactoryDispatcherInput.Tuning = %+v, want the default tuning", in.Tuning)
	}
}

// TestEnsureFactoryDispatcherReturnsAStartFailure proves a real failure — not the
// harmless already-started case — reaches the caller, which crashloops the
// pod on it: a dispatcher that silently never started looks identical to a
// paused one from outside the process.
func TestEnsureFactoryDispatcherReturnsAStartFailure(t *testing.T) {
	t.Parallel()

	sentinel := errors.New("frontend unavailable")
	fake := &fakeStarter{err: sentinel}

	err := ensureFactoryDispatcher(context.Background(), fake, discardLogger())
	if err == nil {
		t.Fatal("ensureFactoryDispatcher: want an error, got nil")
	}
	if !errors.Is(err, sentinel) {
		t.Errorf("ensureFactoryDispatcher error = %v, want it to wrap %v", err, sentinel)
	}
}
