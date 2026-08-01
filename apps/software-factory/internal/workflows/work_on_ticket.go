package workflows

import (
	"fmt"
	"strings"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// targetRecordingActs, runWorkerControlActs, and targetRunWorkerActs name the
// target activity boundaries. Temporal resolves their registered method names;
// workflow code never invokes the nil receivers directly.
var (
	targetRecordingActs  *activities.TargetRecordingActivities
	runWorkerControlActs *activities.RunWorkerControlActivities
	targetRunWorkerActs  *activities.RunWorkerActivities
)

// WorkOnTicketInput is the immutable admission policy and repository source
// for one target Ticket workflow.
type WorkOnTicketInput struct {
	TicketID store.TicketID
	RunID    string
	Policy   work.TargetRunPolicy
	CloneURL string
}

// WorkOnTicket claims one Ticket before creating generation one, creates its
// private Run Worker Session, and clones the repository as that Session's
// first repository-affine activity.
func WorkOnTicket(ctx workflow.Context, in WorkOnTicketInput) error {
	if err := validateWorkOnTicket(in); err != nil {
		return err
	}
	identity, err := work.NewRunWorkerIdentity(in.RunID, 1)
	if err != nil {
		return temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("the target Run %q cannot own a Run Worker: %v", in.RunID, err),
			activities.ErrTypeInvalid,
			nil,
		)
	}

	claimCtx := workflow.WithActivityOptions(ctx, targetActivityOptions(in.Policy.Recording))
	var claimed store.ClaimRunResult
	if err := workflow.ExecuteActivity(claimCtx, targetRecordingActs.ClaimAndStartRun, store.ClaimRunInput{
		TicketID:  in.TicketID,
		RunID:     in.RunID,
		StartedAt: workflow.Now(ctx),
	}).Get(claimCtx, &claimed); err != nil {
		return fmt.Errorf("claiming ticket %d: %w", in.TicketID, err)
	}

	branch := work.FactoryTicketBranchName(int64(claimed.Ticket.ID), in.RunID)
	controlCtx := workflow.WithActivityOptions(ctx, targetActivityOptions(in.Policy.Provisioning))
	if err := workflow.ExecuteActivity(controlCtx, runWorkerControlActs.ProvisionRunWorker, activities.ProvisionRunWorkerInput{
		TicketNumber: int(claimed.Ticket.ID),
		Identity:     identity,
		Branch:       branch,
	}).Get(controlCtx, nil); err != nil {
		return fmt.Errorf("provisioning Run Worker generation one: %w", err)
	}

	privateQueue, err := work.RunWorkerTaskQueue(identity)
	if err != nil {
		return fmt.Errorf("building Run Worker private task queue: %w", err)
	}
	sessionOptions := targetActivityOptions(in.Policy.Provisioning)
	sessionOptions.TaskQueue = privateQueue
	sessionCtx, err := workflow.CreateSession(workflow.WithActivityOptions(ctx, sessionOptions), &workflow.SessionOptions{
		ExecutionTimeout: in.Policy.HardDeadline,
		CreationTimeout:  in.Policy.Provisioning.ScheduleToCloseTimeout,
		HeartbeatTimeout: in.Policy.Agent.HeartbeatTimeout,
	})
	if err != nil {
		return fmt.Errorf("creating Run Worker Session: %w", err)
	}
	defer workflow.CompleteSession(sessionCtx)

	if err := workflow.ExecuteActivity(sessionCtx, targetRunWorkerActs.CloneTargetRepository, activities.CloneTargetRepositoryInput{
		Step:     activities.RepositoryStep{StepOrdinal: 1, Branch: branch},
		CloneURL: in.CloneURL,
	}).Get(sessionCtx, nil); err != nil {
		return fmt.Errorf("cloning the target repository: %w", err)
	}
	return nil
}

func validateWorkOnTicket(in WorkOnTicketInput) error {
	if in.TicketID <= 0 {
		return temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("ticket id %d is not a target Ticket", in.TicketID),
			activities.ErrTypeInvalid,
			nil,
		)
	}
	if err := in.Policy.Validate(); err != nil {
		return temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("the target run policy for ticket %d is unusable: %v", in.TicketID, err),
			activities.ErrTypeInvalid,
			nil,
		)
	}
	if strings.TrimSpace(in.CloneURL) == "" {
		return temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("ticket %d has no repository clone URL", in.TicketID),
			activities.ErrTypeInvalid,
			nil,
		)
	}
	return nil
}

func targetActivityOptions(policy work.ActivityPolicy) workflow.ActivityOptions {
	return workflow.ActivityOptions{
		StartToCloseTimeout:    policy.StartToCloseTimeout,
		ScheduleToCloseTimeout: policy.ScheduleToCloseTimeout,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    policy.Retry.InitialInterval,
			BackoffCoefficient: policy.Retry.BackoffCoefficient,
			MaximumInterval:    policy.Retry.MaximumInterval,
			MaximumAttempts:    policy.Retry.MaximumAttempts,
		},
	}
}
