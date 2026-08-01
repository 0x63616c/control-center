package workflows

import (
	"fmt"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// maintainActs names the Store-backed recovery activities. Registration stays
// inactive until the PR 8 cutover; the workflow is intentionally safe to
// register with a Temporal Schedule later without changing its behavior.
var maintainActs *activities.TargetMaintenanceActivities

// MaintainFactory performs one bounded recovery pass. Its eventual Temporal
// Schedule supplies recurrence; keeping this workflow finite means a failed
// pass is naturally retried by the Schedule rather than holding live state.
func MaintainFactory(ctx workflow.Context) error {
	control := workflow.WithActivityOptions(ctx, maintenanceActivityOptions())
	var owners []store.ActiveTargetRunOwner
	if err := workflow.ExecuteActivity(control, maintainActs.ListActiveTargetRunOwners).Get(control, &owners); err != nil {
		return fmt.Errorf("listing active target run owners: %w", err)
	}
	for _, owner := range owners {
		var state work.RunState
		workflowID := work.FactoryTicketWorkflowID(int64(owner.TicketID))
		if err := workflow.ExecuteActivity(control, acts.DescribeRun, workflowID).Get(control, &state); err != nil {
			return fmt.Errorf("describing target ticket workflow %s: %w", workflowID, err)
		}
		if state.Open && state.RunID == owner.RunID {
			continue
		}

		identity, err := work.NewRunWorkerIdentity(owner.RunID, 1)
		if err != nil {
			return temporal.NewNonRetryableApplicationError("active target ticket has an invalid Run owner", activities.ErrTypeInvalid, err)
		}
		if err := workflow.ExecuteActivity(control, runWorkerControlActs.DeleteRunWorker, activities.DeleteRunWorkerInput{Identity: identity}).Get(control, nil); err != nil {
			return fmt.Errorf("deleting orphaned Run Worker for %s: %w", owner.RunID, err)
		}
		var reopened bool
		if err := workflow.ExecuteActivity(control, maintainActs.ReconcileAbandonedTargetRun, owner.RunID, owner.TicketID).Get(control, &reopened); err != nil {
			return fmt.Errorf("reconciling abandoned target run %s: %w", owner.RunID, err)
		}
		if !reopened {
			workflow.GetLogger(ctx).Info("target maintenance ownership was already replaced", "ticket_id", int64(owner.TicketID), "run_id", owner.RunID)
		}
	}
	return nil
}

func maintenanceActivityOptions() workflow.ActivityOptions {
	return workflow.ActivityOptions{
		StartToCloseTimeout: time.Minute,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 3},
	}
}
