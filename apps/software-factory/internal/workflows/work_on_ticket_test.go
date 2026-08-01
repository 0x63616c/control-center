package workflows_test

import (
	"context"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store/storefake"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/worker"
)

// TestWorkOnTicketClaimsBeforeProvisioningGenerationOneAndClonesThroughItsSession
// holds the first target-run boundary: the Store records ownership before a
// Run Worker exists, Session creation is the readiness handoff, and clone is
// the first repository-affine activity on that worker's queue.
func TestWorkOnTicketClaimsBeforeProvisioningGenerationOneAndClonesThroughItsSession(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	recorderStore := storefake.New()
	ticket, err := recorderStore.CreateTicket(ctx, "target run", "clone the repository", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	input := workflows.WorkOnTicketInput{
		TicketID: ticket.ID,
		RunID:    "0f466627-b3ae-4ba2-9c96-6ef44ec6f578",
		Policy:   work.DefaultTargetRunPolicy(),
		CloneURL: "https://github.com/example/repository.git",
	}

	winner := newWorkOnTicketHarness(t, recorderStore)
	winner.run(input)
	if err := winner.env.GetWorkflowError(); err != nil {
		t.Fatalf("winning WorkOnTicket: %v", err)
	}
	if winner.provisioned.Identity.Generation != 1 {
		t.Fatalf("provisioned generation = %d, want 1", winner.provisioned.Identity.Generation)
	}
	claimed, err := recorderStore.Ticket(ctx, ticket.ID)
	if err != nil {
		t.Fatalf("Ticket: %v", err)
	}
	if claimed.State != store.TicketActive || claimed.ActiveRunID != winner.provisioned.Identity.RunID {
		t.Fatalf("claimed ticket = %+v, want active owner %q", claimed, winner.provisioned.Identity.RunID)
	}
	if winner.clone.Step.StepOrdinal != 1 || winner.clone.Step.Branch != winner.provisioned.Branch || winner.clone.CloneURL != input.CloneURL {
		t.Fatalf("clone = %+v, provision = %+v", winner.clone, winner.provisioned)
	}
	loser := newWorkOnTicketHarness(t, recorderStore)
	loserInput := input
	loserInput.RunID = "0f466627-b3ae-4ba2-9c96-6ef44ec6f579"
	loser.run(loserInput)
	if err := loser.env.GetWorkflowError(); err == nil {
		t.Fatal("losing WorkOnTicket succeeded")
	}
	if loser.provisioned.Identity != (work.RunWorkerIdentity{}) || loser.clone.Step != (activities.RepositoryStep{}) {
		t.Fatalf("losing WorkOnTicket reached private work: provision = %+v, clone = %+v", loser.provisioned, loser.clone)
	}
}

type workOnTicketHarness struct {
	env *testsuite.TestWorkflowEnvironment

	provisioned activities.ProvisionRunWorkerInput
	clone       activities.CloneTargetRepositoryInput
}

func newWorkOnTicketHarness(t *testing.T, recorderStore *storefake.Store) *workOnTicketHarness {
	t.Helper()
	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestWorkflowEnvironment()
	env.SetWorkerOptions(worker.Options{
		EnableSessionWorker:               true,
		MaxConcurrentSessionExecutionSize: 1,
	})
	recording, err := activities.NewTargetRecordingActivities(recorderStore)
	if err != nil {
		t.Fatalf("NewTargetRecordingActivities: %v", err)
	}
	env.RegisterActivity(recording)

	h := &workOnTicketHarness{env: env}
	env.RegisterActivityWithOptions(
		func(_ context.Context, in activities.ProvisionRunWorkerInput) (activities.ProvisionRunWorkerOutput, error) {
			h.provisioned = in
			id, err := work.RunWorkerName(in.Identity)
			if err != nil {
				return activities.ProvisionRunWorkerOutput{}, err
			}
			return activities.ProvisionRunWorkerOutput{ID: id}, nil
		},
		activity.RegisterOptions{Name: "ProvisionRunWorker"},
	)
	env.RegisterActivityWithOptions(
		func(_ context.Context, in activities.CloneTargetRepositoryInput) (activities.CloneTargetRepositoryOutput, error) {
			h.clone = in
			return activities.CloneTargetRepositoryOutput{HeadSHA: "candidate-head"}, nil
		},
		activity.RegisterOptions{Name: "CloneTargetRepository"},
	)
	return h
}

func (h *workOnTicketHarness) run(in workflows.WorkOnTicketInput) {
	h.env.ExecuteWorkflow(workflows.WorkOnTicket, in)
}
