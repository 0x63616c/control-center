package workflows

import (
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	enums "go.temporal.io/api/enums/v1"
)

// The child options are asserted directly rather than through a run, because
// the thing that matters about them is invisible until the parent closes: a
// test environment that never continues as new would pass with either policy.
func TestChildrenAreStartedAbandonedSoContinueAsNewDoesNotKillThem(t *testing.T) {
	t.Parallel()

	d := newDispatcher(DispatcherInput{Config: work.DefaultDispatcherConfig()})

	options := d.childOptions(328)

	if options.ParentClosePolicy != enums.PARENT_CLOSE_POLICY_ABANDON {
		t.Fatalf("ParentClosePolicy = %v, want ABANDON. The default is TERMINATE, and ContinueAsNew closes the "+
			"parent run — so the default would have the dispatcher kill every ticket it had just started, every "+
			"few hours (ADR-0011)", options.ParentClosePolicy)
	}
}

func TestAChildsWorkflowIDIsTheClaimOnItsTicket(t *testing.T) {
	t.Parallel()

	d := newDispatcher(DispatcherInput{Config: work.DefaultDispatcherConfig()})

	if got := d.childOptions(328).WorkflowID; got != work.WorkflowID(328) {
		t.Fatalf("WorkflowID = %q, want %q — starting a workflow with this ID *is* the claim, so a second "+
			"spelling would be a second claim", got, work.WorkflowID(328))
	}
}

func TestAChildIsGivenLongerThanItsStagesCanTake(t *testing.T) {
	t.Parallel()

	config := work.DefaultDispatcherConfig()
	d := newDispatcher(DispatcherInput{Config: config})

	if got := d.childOptions(328).WorkflowRunTimeout; got <= config.Run.RunBudget() {
		t.Fatalf("run timeout %s does not exceed the stages' own budget %s, so a run using its stage timeouts "+
			"would be killed for taking exactly as long as it was allowed", got, config.Run.RunBudget())
	}
}
