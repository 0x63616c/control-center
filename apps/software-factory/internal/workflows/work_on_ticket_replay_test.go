package workflows_test

import (
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
	"go.temporal.io/sdk/worker"
)

// TestWorkOnTicketReplaysExportedHistory protects the target workflow's
// command sequence with the same JSON format emitted by `temporal workflow
// show`. The fixture reaches the first durable claim activity.
func TestWorkOnTicketReplaysExportedHistory(t *testing.T) {
	t.Parallel()
	replayer := worker.NewWorkflowReplayer()
	replayer.RegisterWorkflow(workflows.WorkOnTicket)
	if err := replayer.ReplayWorkflowHistoryFromJSONFile(nil, "testdata/work-on-ticket-history.json"); err != nil {
		t.Fatalf("replay WorkOnTicket history: %v", err)
	}
}
