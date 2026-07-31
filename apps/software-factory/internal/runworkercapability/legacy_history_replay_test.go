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

func TestLegacyFactoryDispatcherHistoryReplays(t *testing.T) {
	history := readLegacyHistoryFixture(t)
	assertRepresentativeLegacyHistory(t, history)

	replayer := worker.NewWorkflowReplayer()
	replayer.RegisterWorkflow(workflows.FactoryDispatcher)
	if err := replayer.ReplayWorkflowHistory(nil, history); err != nil {
		t.Fatalf("replaying %s through the unchanged FactoryDispatcher registration: %v", legacyHistoryFixture, err)
	}
}

func readLegacyHistoryFixture(t *testing.T) *historypb.History {
	t.Helper()
	data, err := os.ReadFile(legacyHistoryFixture)
	if err != nil {
		t.Fatalf("reading %s: %v", legacyHistoryFixture, err)
	}
	history := &historypb.History{}
	if err := (temporalproto.CustomJSONUnmarshalOptions{}).Unmarshal(data, history); err != nil {
		t.Fatalf("decoding %s: %v", legacyHistoryFixture, err)
	}
	return history
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
