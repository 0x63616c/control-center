package runworkercapability

import (
	"os"
	"testing"

	enums "go.temporal.io/api/enums/v1"
	historypb "go.temporal.io/api/history/v1"
	"go.temporal.io/api/temporalproto"
	"go.temporal.io/sdk/worker"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
)

const (
	legacyHistoryFixture                  = "../workflows/testdata/factory-dispatcher-paused.json"
	legacyFactoryWorkTicketHistoryFixture = "../workflows/testdata/factory-work-ticket-pre-agent.json"
	targetDispatcherHistoryFixture        = "../workflows/testdata/target-dispatcher-admission.json"
)

func TestLegacyFactoryDispatcherHistoryReplays(t *testing.T) {
	history := readLegacyHistoryFixture(t)
	assertRepresentativeLegacyHistory(t, history)

	replayer := worker.NewWorkflowReplayer()
	replayer.RegisterWorkflow(workflows.FactoryDispatcher)
	if err := replayer.ReplayWorkflowHistory(nil, history); err != nil {
		t.Fatalf("replaying %s through the unchanged FactoryDispatcher registration: %v", legacyHistoryFixture, err)
	}
}

// TestLegacyFactoryWorkTicketHistoryReplays proves the version gate against a
// persisted history produced by FactoryWorkTicket before AgentWorkflow
// existed. The fixture reaches a scheduled RunPlan under the old run-wide
// Session and is then terminated. Replaying it through today's registration
// must therefore select workflow.DefaultVersion and reproduce the legacy
// activity command instead of trying to start a child workflow.
func TestLegacyFactoryWorkTicketHistoryReplays(t *testing.T) {
	history := readHistoryFixture(t, legacyFactoryWorkTicketHistoryFixture)
	assertPreAgentFactoryWorkTicketHistory(t, history)

	replayer := worker.NewWorkflowReplayer()
	replayer.RegisterWorkflow(workflows.FactoryWorkTicket)
	if err := replayer.ReplayWorkflowHistory(nil, history); err != nil {
		t.Fatalf("replaying %s through FactoryWorkTicket's compatibility branch: %v", legacyFactoryWorkTicketHistoryFixture, err)
	}
}

// TestTargetDispatcherHistoryReplays is the compatibility guard for the v0
// dispatcher before its registration is enabled. Its fixture is deliberately
// an exported dev-server history, not a testsuite transcript: a future command
// change must replay the same wait and child-admission sequence Temporal saw.
func TestTargetDispatcherHistoryReplays(t *testing.T) {
	history := readHistoryFixture(t, targetDispatcherHistoryFixture)
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

func readHistoryFixture(t *testing.T, path string) *historypb.History {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	history := &historypb.History{}
	if err := (temporalproto.CustomJSONUnmarshalOptions{}).Unmarshal(data, history); err != nil {
		t.Fatalf("decoding %s: %v", path, err)
	}
	return history
}

func assertPreAgentFactoryWorkTicketHistory(t *testing.T, history *historypb.History) {
	t.Helper()
	runPlanScheduled := false
	versionMarkerRecorded := false
	for _, event := range history.Events {
		if attrs := event.GetActivityTaskScheduledEventAttributes(); attrs != nil &&
			attrs.GetActivityType().GetName() == "RunPlan" {
			runPlanScheduled = true
		}
		if attrs := event.GetMarkerRecordedEventAttributes(); attrs != nil &&
			attrs.GetMarkerName() == "Version" {
			versionMarkerRecorded = true
		}
	}
	if !runPlanScheduled || versionMarkerRecorded {
		t.Fatalf(
			"pre-agent history must schedule RunPlan without a Version marker; run_plan_scheduled=%t version_marker_recorded=%t",
			runPlanScheduled,
			versionMarkerRecorded,
		)
	}
}

func assertRepresentativeTargetDispatcherHistory(t *testing.T, history *historypb.History) {
	t.Helper()
	activityCompleted := false
	activityRetried := false
	childStarted := false
	childUsesMainRunQueue := false
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
			attributes := event.GetStartChildWorkflowExecutionInitiatedEventAttributes()
			childUsesMainRunQueue = attributes.GetTaskQueue().GetName() == work.TaskQueue
			childRequestsCancellation = attributes.GetParentClosePolicy() == enums.PARENT_CLOSE_POLICY_REQUEST_CANCEL
		}
	}
	if !activityCompleted || !activityRetried || !childStarted || !childUsesMainRunQueue || !childRequestsCancellation {
		t.Fatalf(
			"target dispatcher history must contain a retried wait, completed dispatch, and child admission on the main run queue that requests cancellation; activity_completed=%t activity_retried=%t child_started=%t child_uses_main_run_queue=%t child_requests_cancellation=%t",
			activityCompleted, activityRetried, childStarted, childUsesMainRunQueue, childRequestsCancellation,
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
