package main

import (
	"os"
	"regexp"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// TestTheWorkerPollsTheQueueTheWorkflowsScheduleOnto is the demonstration
// work.TaskQueue was extracted for and did not yet have.
//
// The constant landed with zero consumers, so nothing showed the worker
// registering on it rather than on a literal — and this composition root is
// exactly where a second spelling would appear. It has to be caught here
// because it cannot be caught later: a worker polling a queue nobody schedules
// onto raises no error, crashes nothing and fails no test. It looks precisely
// like a system with no work to do.
//
// Asserted against the source rather than by running a worker, because the
// alternative is a live Temporal. That is a real limit of this test: it proves
// the call site names the constant, not that the SDK received it.
func TestTheWorkerPollsTheQueueTheWorkflowsScheduleOnto(t *testing.T) {
	t.Parallel()

	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("reading main.go: %v", err)
	}

	// worker.New's second argument is the queue polled. Anything but the
	// shared constant there is a second spelling of a name that must have one.
	registration := regexp.MustCompile(`worker\.New\([^,]+,\s*([^,]+),`)
	found := registration.FindSubmatch(source)
	if found == nil {
		t.Fatal("no worker.New call found in main.go; this test cannot see what queue the worker polls")
	}
	if got := string(found[1]); got != "work.TaskQueue" {
		t.Errorf("the worker registers on %s, want work.TaskQueue; a worker polling a queue nothing schedules onto reports no error at either end and looks like an idle system", got)
	}
}

// TestTheQueueAndTheNamespaceAreNotTheSameField guards a readability trap
// rather than a defect: the task queue and the Temporal namespace are both the
// string "software-factory", and they appear side by side on runbook command
// lines where a transposed --task-queue/--namespace flag would be invisible.
//
// If they ever diverge this test is noise and should be deleted. While they
// agree, it is a place for the next person to find out that they do.
func TestTheQueueAndTheNamespaceAreNotTheSameField(t *testing.T) {
	t.Parallel()

	if work.TaskQueue != "software-factory" {
		t.Errorf("work.TaskQueue = %q; if the queue name has moved, check every runbook that also passes a --namespace", work.TaskQueue)
	}
}
