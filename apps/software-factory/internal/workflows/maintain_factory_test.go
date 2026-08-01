package workflows_test

import (
	"context"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
	"github.com/stretchr/testify/mock"
	"go.temporal.io/sdk/testsuite"
)

func TestMaintainFactoryReconcilesClosedOwnerAndDeletesItsRunWorker(t *testing.T) {
	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestWorkflowEnvironment()
	owner := activities.TargetRunOwner{TicketID: 7, RunID: "019fb900-0000-7000-8000-000000000007"}
	env.OnActivity(maintainActs.ListActiveTargetRunOwners, mock.Anything).Return([]activities.TargetRunOwner{owner}, nil)
	env.OnActivity(acts.DescribeRun, mock.Anything, work.FactoryTicketWorkflowID(int64(owner.TicketID))).Return(work.RunState{Open: false}, nil)
	deleted := false
	env.OnActivity(runWorkerControlActs.DeleteRunWorker, mock.Anything, mock.Anything).
		Return(func(_ context.Context, in activities.DeleteRunWorkerInput) error {
			identity, err := work.NewRunWorkerIdentity(owner.RunID, 1)
			if err != nil {
				t.Fatalf("NewRunWorkerIdentity: %v", err)
			}
			if in.Identity != identity {
				t.Errorf("deleted identity = %+v, want %+v", in.Identity, identity)
			}
			deleted = true
			return nil
		})
	var reconciled activities.TargetRunOwner
	env.OnActivity(maintainActs.ReconcileAbandonedTargetRun, mock.Anything, owner.RunID, owner.TicketID).
		Return(func(_ context.Context, runID string, ticketID store.TicketID) (bool, error) {
			reconciled = activities.TargetRunOwner{RunID: runID, TicketID: ticketID}
			return true, nil
		})

	env.ExecuteWorkflow(workflows.MaintainFactory)
	if err := env.GetWorkflowError(); err != nil {
		t.Fatalf("MaintainFactory: %v", err)
	}
	if !deleted {
		t.Error("closed run's Run Worker was not deleted")
	}
	if reconciled != owner {
		t.Errorf("reconciled owner = %+v, want %+v", reconciled, owner)
	}
}

func TestMaintainFactoryLeavesTheCurrentLiveOwnerUntouched(t *testing.T) {
	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestWorkflowEnvironment()
	owner := activities.TargetRunOwner{TicketID: 8, RunID: "019fb900-0000-7000-8000-000000000008"}
	env.OnActivity(maintainActs.ListActiveTargetRunOwners, mock.Anything).Return([]activities.TargetRunOwner{owner}, nil)
	env.OnActivity(acts.DescribeRun, mock.Anything, work.FactoryTicketWorkflowID(int64(owner.TicketID))).Return(work.RunState{Open: true, RunID: owner.RunID}, nil)

	env.ExecuteWorkflow(workflows.MaintainFactory)
	if err := env.GetWorkflowError(); err != nil {
		t.Fatalf("MaintainFactory: %v", err)
	}
}
