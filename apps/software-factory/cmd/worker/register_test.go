package main

import (
	"os"
	"strings"
	"testing"
)

// TestRegisterRegistersBothWorkflowsAndTheActivities is the demonstration
// register's own doc comment promises and did not yet have: the dispatcher
// and ticket workflows, and the activity sets, actually land on the worker
// rather than the function staying the one log line it started as (#340). See TestTheWorkerPollsTheQueueTheWorkflowsScheduleOnto for why this
// is a source-level assertion rather than a run against a live worker: the
// alternative is a live Temporal, and this file already has that pattern.
func TestRegisterRegistersBothWorkflowsAndTheActivities(t *testing.T) {
	t.Parallel()

	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("reading main.go: %v", err)
	}
	body := extractRegisterBody(t, string(source))

	for _, want := range []string{
		"w.RegisterWorkflow(workflows.FactoryWorkTicket)",
		"w.RegisterWorkflow(workflows.FactoryDispatcher)",
		"w.RegisterWorkflow(workflows.WorkOnTicket)",
		"w.RegisterActivity(targetRecordingActs)",
		"w.RegisterActivity(",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("register()'s body does not contain %q; the worker registers nothing it does not name here", want)
		}
	}
}

// extractRegisterBody returns the text of the register function, so the
// assertions above cannot pass by matching a registration call anywhere else
// in the file — the whole point of "one function, one call site" is that
// there is exactly one place to look.
func extractRegisterBody(t *testing.T, source string) string {
	t.Helper()

	start := strings.Index(source, "func register(")
	if start < 0 {
		t.Fatal("main.go has no register( function")
	}
	// The next top-level "\n}\n" after the opening brace ends the function;
	// register has no nested func literals today, so a brace-depth scan is
	// more machinery than this needs.
	end := strings.Index(source[start:], "\n}\n")
	if end < 0 {
		t.Fatal("could not find the end of register()")
	}
	return source[start : start+end]
}
