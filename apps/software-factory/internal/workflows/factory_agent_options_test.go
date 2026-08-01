package workflows

import (
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/api/enums/v1"
)

func TestAgentChildOptionsAreParentOwnedAndHaveNoWorkflowRetry(t *testing.T) {
	t.Parallel()

	policy := work.DefaultRunPolicy()
	key := work.StageKey{RunID: "run-7", Stage: work.StageImplement, Turn: 2}
	options := agentChildWorkflowOptions(policy, key)
	if options.WorkflowID != agent.WorkflowID("run-7", string(work.StageImplement), 2) ||
		options.WorkflowExecutionTimeout != policy.StageTimeout || !options.WaitForCancellation ||
		options.ParentClosePolicy != enums.PARENT_CLOSE_POLICY_REQUEST_CANCEL || options.RetryPolicy != nil {
		t.Fatalf("agent child options = %#v", options)
	}
}
