package work

import (
	"strings"
	"testing"
)

// TestTaskQueueIsPinnedToItsPublishedName holds the constant against a literal.
//
// The name is published outside this module — the deploy's Deployment and the
// first-run runbook both name the queue an operator has to look at in
// Temporal's UI — so renaming it is a change to those too. A rename that
// compiles and passes everything else produces a worker polling a queue nobody
// schedules onto: no error at either end, no failed test, and a system that
// looks exactly like one with nothing to do.
//
// This test is what makes that rename deliberate. If it fails, the fix is not
// to update the literal on its own.
func TestTaskQueueIsPinnedToItsPublishedName(t *testing.T) {
	t.Parallel()

	if TaskQueue != "software-factory" {
		t.Errorf("TaskQueue = %q, want %q: the deploy and the first-run runbook name this queue too, so a rename has to travel with them",
			TaskQueue, "software-factory")
	}
}

func TestTaskQueueIsUsableAsATaskQueueName(t *testing.T) {
	t.Parallel()

	// Temporal takes any non-empty string, so the checks that matter are the
	// ones a human pays for: a queue with a space or a newline in it is one
	// nobody can type into a CLI or a UI filter correctly, and an empty one
	// is a worker that polls a queue named "".
	switch {
	case TaskQueue == "":
		t.Error("TaskQueue is empty")
	case strings.TrimSpace(TaskQueue) != TaskQueue:
		t.Errorf("TaskQueue %q is padded with whitespace", TaskQueue)
	case strings.ContainsAny(TaskQueue, " \t\n\r"):
		t.Errorf("TaskQueue %q contains whitespace", TaskQueue)
	}
}

// TestSandboxTaskQueueIsDerivedPerRun pins the D1 shape: one pod, one ticket,
// one queue that names it — never the shared constant a warm pool would need.
func TestSandboxTaskQueueIsDerivedPerRun(t *testing.T) {
	t.Parallel()

	a := SandboxTaskQueue("run-a")
	b := SandboxTaskQueue("run-b")

	if a == b {
		t.Errorf("SandboxTaskQueue(%q) and SandboxTaskQueue(%q) collided on %q; two tickets would poll the same queue", "run-a", "run-b", a)
	}
	if a == TaskQueue || b == TaskQueue {
		t.Error("a sandbox queue name collided with the main worker's TaskQueue")
	}
	if got := SandboxTaskQueue("run-a"); got != a {
		t.Errorf("SandboxTaskQueue(%q) = %q then %q; the same run must always name the same queue", "run-a", a, got)
	}
}

// TestSandboxTaskQueueIsUsableAsATaskQueueName holds the same human-typeable
// bar TaskQueue is held to, against a realistic Temporal RunID.
func TestSandboxTaskQueueIsUsableAsATaskQueueName(t *testing.T) {
	t.Parallel()

	got := SandboxTaskQueue("b6f1e2b2-1c1e-4b1a-9c1a-1234567890ab")
	switch {
	case got == "":
		t.Error("SandboxTaskQueue returned an empty name")
	case strings.TrimSpace(got) != got:
		t.Errorf("SandboxTaskQueue name %q is padded with whitespace", got)
	case strings.ContainsAny(got, " \t\n\r"):
		t.Errorf("SandboxTaskQueue name %q contains whitespace", got)
	case !strings.HasPrefix(got, "software-factory-sandbox-"):
		t.Errorf("SandboxTaskQueue name %q does not carry the published prefix an operator would filter on", got)
	}
}

// TestSandboxTaskQueueEnvIsPinnedToItsPublishedName holds the env var name
// against a literal for the same reason TestTaskQueueIsPinnedToItsPublishedName
// does: CreateSandbox's pod spec and cmd/sandbox-worker's config both name it,
// so a rename that compiles here but not there is a pod polling nothing.
func TestSandboxTaskQueueEnvIsPinnedToItsPublishedName(t *testing.T) {
	t.Parallel()

	if SandboxTaskQueueEnv != "SANDBOX_TASK_QUEUE" {
		t.Errorf("SandboxTaskQueueEnv = %q, want %q", SandboxTaskQueueEnv, "SANDBOX_TASK_QUEUE")
	}
}
