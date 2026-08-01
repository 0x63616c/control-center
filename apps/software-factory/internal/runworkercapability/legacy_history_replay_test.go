package runworkercapability

import (
	"os"
	"testing"

	enums "go.temporal.io/api/enums/v1"
	historypb "go.temporal.io/api/history/v1"
	"go.temporal.io/api/temporalproto"
	"go.temporal.io/sdk/worker"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
)

const legacyHistoryFixture = "../workflows/testdata/factory-dispatcher-paused.json"

const targetDispatcherHistoryFixture = "../workflows/testdata/target-dispatcher-admission.json"

func TestLegacyFactoryDispatcherHistoryReplays(t *testing.T) {
	history := readLegacyHistoryFixture(t)
	assertRepresentativeLegacyHistory(t, history)

	replayer := worker.NewWorkflowReplayer()
	replayer.RegisterWorkflow(workflows.FactoryDispatcher)
	if err := replayer.ReplayWorkflowHistory(nil, history); err != nil {
		t.Fatalf("replaying %s through the unchanged FactoryDispatcher registration: %v", legacyHistoryFixture, err)
	}
}

// TestTargetDispatcherHistoryReplays is the compatibility guard for the v0
// dispatcher before its registration is enabled. Its fixture is deliberately
// an exported dev-server history, not a testsuite transcript: a future command
// change must replay the same wait and child-admission sequence Temporal saw.
func TestTargetDispatcherHistoryReplays(t *testing.T) {
	history := readTargetDispatcherHistoryFixture(t)
	assertRepresentativeTargetDispatcherHistory(t, history)

	replayer := worker.NewWorkflowReplayer()
	replayer.RegisterWorkflow(workflows.Dispatcher)
	if err := replayer.ReplayWorkflowHistory(nil, history); err != nil {
		t.Fatalf("replaying %s through the Dispatcher registration: %v", targetDispatcherHistoryFixture, err)
	}
}

func readLegacyHistoryFixture(t *testing.T) *historypb.History {
	t.Helper()
	return readHistoryFixture(t, legacyHistoryFixture)
}

func readTargetDispatcherHistoryFixture(t *testing.T) *historypb.History {
	t.Helper()
	return readHistoryFixture(t, targetDispatcherHistoryFixture)
}

func readHistoryFixture(t *testing.T, fixture string) *historypb.History {
	t.Helper()
	data, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatalf("reading %s: %v", fixture, err)
	}
	history := &historypb.History{}
	if err := (temporalproto.CustomJSONUnmarshalOptions{}).Unmarshal(data, history); err != nil {
		t.Fatalf("decoding %s: %v", fixture, err)
	}
	return history
}

func assertRepresentativeTargetDispatcherHistory(t *testing.T, history *historypb.History) {
	t.Helper()
	activityCompleted := false
	activityRetried := false
	childStarted := false
	childRequestsCancellation := false
	for _, event := range history.Events {
		if event.GetEventType() == enums.EVENT_TYPE_ACTIVITY_TASK_COMPLETED {
			activityCompleted = true
		}
		if event.GetEventType() == enums.EVENT_TYPE_ACTIVITY_TASK_STARTED && event.GetActivityTaskStartedEventAttributes().GetAttempt() > 1 {
			activityRetried = true
		}
		if event.GetEventType() == enums.EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_INITIATED {
			childStarted = true
			childRequestsCancellation = event.GetStartChildWorkflowExecutionInitiatedEventAttributes().GetParentClosePolicy() == enums.PARENT_CLOSE_POLICY_REQUEST_CANCEL
		}
	}
	if !activityCompleted || !activityRetried || !childStarted || !childRequestsCancellation {
		t.Fatalf(
			"target dispatcher history must contain a retried wait, completed dispatch, and child admission that requests cancellation; activity_completed=%t activity_retried=%t child_started=%t child_requests_cancellation=%t",
			activityCompleted, activityRetried, childStarted, childRequestsCancellation,
		)
	}
}

func assertRepresentativeLegacyHistory(t *testing.T, history *historypb.History) {
	t.Helper()
	activityCompleted := false
	timerFired := false
	workflowAdvancedAfterTimer := false
	for _, event := range history.Events {
		eventType := event.GetEventType()
		if eventType == enums.EVENT_TYPE_ACTIVITY_TASK_COMPLETED {
			activityCompleted = true
		}
		if eventType == enums.EVENT_TYPE_TIMER_FIRED {
			timerFired = true
		}
		if eventType == enums.EVENT_TYPE_WORKFLOW_TASK_COMPLETED && timerFired {
			workflowAdvancedAfterTimer = true
		}
	}
	if !activityCompleted || !timerFired || !workflowAdvancedAfterTimer {
		t.Fatalf(
			"legacy history must contain an activity completion and a completed workflow task after a fired timer; activity_completed=%t timer_fired=%t workflow_advanced=%t",
			activityCompleted,
			timerFired,
			workflowAdvancedAfterTimer,
		)
	}
}
