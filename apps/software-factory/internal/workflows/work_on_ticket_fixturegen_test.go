//go:build fixturegen

package workflows_test

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store/storefake"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
	historypb "go.temporal.io/api/history/v1"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	temporalworker "go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
	"google.golang.org/protobuf/encoding/protojson"
)

func TestGenerateWorkOnTicketHistory(t *testing.T) {
	ctx := context.Background()
	const runID = "019fb901-0000-7000-8000-000000000033"
	identity := work.RunWorkerIdentity{RunID: runID, Generation: 1}
	privateQueue, err := work.RunWorkerTaskQueue(identity)
	if err != nil {
		t.Fatalf("private queue: %v", err)
	}
	temporalClient, err := client.Dial(client.Options{HostPort: "127.0.0.1:17233"})
	if err != nil {
		t.Fatalf("dial Temporal: %v", err)
	}
	defer temporalClient.Close()

	const mainQueue = "software-factory-work-on-ticket-fixture"
	mainWorker := temporalworker.New(temporalClient, mainQueue, temporalworker.Options{})
	privateWorker := temporalworker.New(temporalClient, privateQueue, temporalworker.Options{
		EnableSessionWorker: true, MaxConcurrentSessionExecutionSize: 1,
	})
	mainWorker.RegisterWorkflow(workflows.WorkOnTicket)
	mainWorker.RegisterWorkflowWithOptions(func(_ workflow.Context, input workflows.AgentWorkflowInput) (workflows.AgentWorkflowResult, error) {
		return targetAgentWorkflowResult(t, input), nil
	}, workflow.RegisterOptions{Name: "AgentWorkflow"})

	s := storefake.New()
	recording, err := activities.NewTargetRecordingActivities(s)
	if err != nil {
		t.Fatalf("recording activities: %v", err)
	}
	recovery, err := activities.NewTargetRecoveryActivities(s)
	if err != nil {
		t.Fatalf("recovery activities: %v", err)
	}
	mainWorker.RegisterActivity(recording)
	mainWorker.RegisterActivity(recovery)
	mainWorker.RegisterActivityWithOptions(func(_ context.Context, input activities.ProvisionRunWorkerInput) (activities.ProvisionRunWorkerOutput, error) {
		id, err := work.RunWorkerName(input.Identity)
		return activities.ProvisionRunWorkerOutput{ID: id}, err
	}, activity.RegisterOptions{Name: "ProvisionRunWorker"})
	mainWorker.RegisterActivityWithOptions(func(ctx context.Context, input activities.AuthorizeRunWorkerAttemptInput) error {
		return s.BindCheckpointCapability(ctx, input.AttemptID, workOnTicketCheckpointCapability)
	}, activity.RegisterOptions{Name: "AuthorizeRunWorkerAttempt"})
	mainWorker.RegisterActivityWithOptions(func(context.Context, activities.RotateRunWorkerGitHubCredentialInput) (work.RunWorkerCredentialRevision, error) {
		return work.RunWorkerCredentialRevision{Revision: "fixture", ExpiresAt: time.Now().Add(time.Hour).UTC()}, nil
	}, activity.RegisterOptions{Name: "RotateRunWorkerGitHubCredential"})
	mainWorker.RegisterActivityWithOptions(func(ctx context.Context, input activities.TargetAgentEvidenceInput) error {
		result, err := json.Marshal(input.Result)
		if err != nil {
			return err
		}
		_, err = s.CheckpointAgentAttempt(ctx, store.AgentCheckpointInput{
			ID: input.AttemptID, Capability: workOnTicketCheckpointCapability, ThreadID: input.Identity,
			State: work.AgentAttemptSucceeded, UsageState: work.UsageMeasured, Usage: input.Usage,
			EndedAt: input.EndedAt, Result: result,
			Transcript: &store.TargetTranscript{CompressedBytes: []byte("fixture transcript"), Compression: "gzip", UncompressedSizeBytes: 18, Checksum: []byte("fixture-checksum")},
		})
		return err
	}, activity.RegisterOptions{Name: "Finalize"})
	mainWorker.RegisterActivityWithOptions(func(context.Context, activities.DeleteRunWorkerInput) error { return nil }, activity.RegisterOptions{Name: "DeleteRunWorker"})

	checkpoint := func(position activities.RepositoryStep) error {
		_, err := s.CheckpointGitEffect(ctx, store.GitCheckpointInput{
			GitCheckpoint: store.GitCheckpoint{
				RunID: runID, StepOrdinal: position.StepOrdinal, Branch: position.Branch,
				PushedHead: position.PushedHead, ObservedBase: position.ObservedBase,
				PullRequestNumber: position.PullRequestNumber, PullRequestNodeID: position.PullRequestNodeID,
				StepResult: json.RawMessage(`{"kind":"fixture"}`),
			},
			CompletedAt: time.Now().UTC(),
		})
		return err
	}
	privateWorker.RegisterActivityWithOptions(func(_ context.Context, input activities.CloneTargetRepositoryInput) (activities.CloneTargetRepositoryOutput, error) {
		position := input.Step
		position.PushedHead = "B0"
		return activities.CloneTargetRepositoryOutput{HeadSHA: "B0"}, checkpoint(position)
	}, activity.RegisterOptions{Name: "CloneTargetRepository"})
	privateWorker.RegisterActivityWithOptions(func(context.Context, activities.RestoreTargetRepositoryInput) error { return nil }, activity.RegisterOptions{Name: "RestoreTargetRepository"})
	privateWorker.RegisterActivityWithOptions(func(_ context.Context, input activities.TargetSyncPullRequestInput) (work.PullRequest, error) {
		position := input.Step
		position.PushedHead, position.PullRequestNumber, position.PullRequestNodeID = "H1", 1, "PR_fixture"
		return work.PullRequest{Number: 1, NodeID: "PR_fixture", HeadSHA: "H1", Draft: true}, checkpoint(position)
	}, activity.RegisterOptions{Name: "TargetSyncPullRequest"})
	privateWorker.RegisterActivityWithOptions(func(_ context.Context, input activities.TargetAwaitCIInput) (activities.AwaitCIOutput, error) {
		return activities.AwaitCIOutput{CommitSHA: "H1", Green: true}, checkpoint(input.Step)
	}, activity.RegisterOptions{Name: "TargetAwaitCI"})
	privateWorker.RegisterActivityWithOptions(func(_ context.Context, input activities.TargetMarkPullRequestReadyInput) error {
		return checkpoint(input.Step)
	}, activity.RegisterOptions{Name: "TargetMarkPullRequestReady"})
	privateWorker.RegisterActivityWithOptions(func(context.Context, activities.TargetMergePullRequestInput) (work.PullRequestMergeResult, error) {
		return work.PullRequestMergeResult{Outcome: work.PullRequestMergeConfirmed, MergeSHA: "M1"}, nil
	}, activity.RegisterOptions{Name: "TargetMergePullRequest"})

	if err := mainWorker.Start(); err != nil {
		t.Fatalf("start main worker: %v", err)
	}
	defer mainWorker.Stop()
	if err := privateWorker.Start(); err != nil {
		t.Fatalf("start private worker: %v", err)
	}
	defer privateWorker.Stop()
	ticket, err := s.CreateTicket(ctx, "replay fixture", "exercise child ordering", nil)
	if err != nil {
		t.Fatalf("create ticket: %v", err)
	}
	input := workflows.WorkOnTicketInput{
		TicketID: ticket.ID, RunID: runID, Policy: work.DefaultTargetRunPolicy(),
		CloneURL: "https://github.com/example/repository.git", Model: work.Model{Name: "gpt-5", Effort: "high"},
	}
	run, err := temporalClient.ExecuteWorkflow(ctx, client.StartWorkflowOptions{ID: "work-on-ticket-replay-fixture-3", TaskQueue: mainQueue}, workflows.WorkOnTicket, input)
	if err != nil {
		t.Fatalf("start WorkOnTicket: %v", err)
	}
	if err := run.Get(ctx, nil); err != nil {
		t.Fatalf("WorkOnTicket: %v", err)
	}

	history := &historypb.History{}
	iterator := temporalClient.GetWorkflowHistory(ctx, run.GetID(), run.GetRunID(), false, 0)
	for iterator.HasNext() {
		event, err := iterator.Next()
		if err != nil {
			t.Fatalf("read history: %v", err)
		}
		history.Events = append(history.Events, event)
	}
	raw, err := protojson.MarshalOptions{Indent: "  "}.Marshal(history)
	if err != nil {
		t.Fatalf("marshal history: %v", err)
	}
	if err := os.WriteFile("testdata/work-on-ticket-history.json", append(raw, '\n'), 0o644); err != nil {
		t.Fatalf("write history: %v", err)
	}
}
