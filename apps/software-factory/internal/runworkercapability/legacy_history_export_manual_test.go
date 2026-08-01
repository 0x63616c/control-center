//go:build manual

package runworkercapability

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	enums "go.temporal.io/api/enums/v1"
	historypb "go.temporal.io/api/history/v1"
	"go.temporal.io/api/temporalproto"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/worker"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	temporalclient "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/temporal"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
	"go.temporal.io/sdk/workflow"
)

func TestExportLegacyFactoryDispatcherHistory(t *testing.T) {
	server, err := testsuite.StartDevServer(context.Background(), testsuite.DevServerOptions{
		CachedDownload: testsuite.CachedDownload{Version: "v1.8.1"},
		LogLevel:       "error",
	})
	if err != nil {
		t.Fatalf("starting Temporal dev server: %v", err)
	}
	t.Cleanup(func() {
		if stopErr := server.Stop(); stopErr != nil {
			t.Errorf("stopping Temporal dev server: %v", stopErr)
		}
	})

	const queue = "legacy-history-export"
	sweepReturned := make(chan struct{}, 1)
	w := worker.New(server.Client(), queue, worker.Options{
		Identity:               "legacy-history-exporter",
		DisableEagerActivities: true,
	})
	w.RegisterWorkflow(workflows.FactoryDispatcher)
	w.RegisterActivityWithOptions(
		func(context.Context, activities.SweepInput) error {
			sweepReturned <- struct{}{}
			return nil
		},
		activity.RegisterOptions{Name: "SweepOrphanSandboxes"},
	)
	if err := w.Start(); err != nil {
		t.Fatalf("starting legacy worker: %v", err)
	}
	t.Cleanup(w.Stop)

	config := work.DefaultFactoryConfig()
	config.Paused = true
	config.PollIntervalSeconds = 1
	run, err := server.Client().ExecuteWorkflow(context.Background(), temporalclient.StartWorkflowOptions{
		ID:        "legacy-factory-dispatcher-history",
		TaskQueue: queue,
	}, workflows.FactoryDispatcher, workflows.FactoryDispatcherInput{
		Config: config,
		Tuning: work.DefaultDispatcherTuning(),
		Run:    work.DefaultRunPolicy(),
	})
	if err != nil {
		t.Fatalf("starting legacy dispatcher: %v", err)
	}
	select {
	case <-sweepReturned:
	case <-time.After(10 * time.Second):
		t.Fatal("legacy dispatcher did not execute its orphan-sweep activity")
	}
	// The exporter is manual-only precisely because this waits on the real
	// server clock. Two poll intervals let the activity completion, fired timer,
	// and subsequent workflow task become durable before termination.
	time.Sleep(2 * time.Duration(config.PollIntervalSeconds) * time.Second)

	if err := server.Client().TerminateWorkflow(context.Background(), run.GetID(), run.GetRunID(), "fixture export"); err != nil {
		t.Fatalf("terminating legacy dispatcher: %v", err)
	}

	history := readTemporalHistory(t, server, run.GetID(), run.GetRunID())
	assertRepresentativeLegacyHistory(t, history)
	encoded, err := (temporalproto.CustomJSONMarshalOptions{Indent: "  "}).Marshal(history)
	if err != nil {
		t.Fatalf("encoding legacy history: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(legacyHistoryFixture), 0o755); err != nil {
		t.Fatalf("creating fixture directory: %v", err)
	}
	if err := os.WriteFile(legacyHistoryFixture, append(encoded, '\n'), 0o600); err != nil {
		t.Fatalf("writing %s: %v", legacyHistoryFixture, err)
	}
}

// TestExportTargetDispatcherHistory captures the v0 dispatcher while it makes
// its core admission decision. It remains manual-only because a real Temporal
// server is what turns those commands into the history replay protects.
func TestExportTargetDispatcherHistory(t *testing.T) {
	server, err := testsuite.StartDevServer(context.Background(), testsuite.DevServerOptions{
		CachedDownload: testsuite.CachedDownload{Version: "v1.8.1"},
		LogLevel:       "error",
	})
	if err != nil {
		t.Fatalf("starting Temporal dev server: %v", err)
	}
	t.Cleanup(func() {
		if stopErr := server.Stop(); stopErr != nil {
			t.Errorf("stopping Temporal dev server: %v", stopErr)
		}
	})

	const queue = "target-dispatcher-history-export"
	w := worker.New(server.Client(), queue, worker.Options{
		Identity:               "target-dispatcher-history-exporter",
		DisableEagerActivities: true,
	})
	w.RegisterWorkflow(workflows.Dispatcher)
	w.RegisterWorkflowWithOptions(targetDispatcherFixtureChild, workflow.RegisterOptions{Name: "WorkOnTicket"})
	w.RegisterActivityWithOptions(
		func(context.Context) ([]store.Ticket, error) {
			return []store.Ticket{{ID: 17, Title: "replay fixture admission", State: store.TicketOpen}}, nil
		},
		activity.RegisterOptions{Name: "AwaitDispatchableTickets"},
	)
	if err := w.Start(); err != nil {
		t.Fatalf("starting target dispatcher worker: %v", err)
	}
	t.Cleanup(w.Stop)

	run, err := server.Client().ExecuteWorkflow(context.Background(), temporalclient.StartWorkflowOptions{
		ID:        work.TargetDispatcherWorkflowID + "-history",
		TaskQueue: queue,
	}, workflows.Dispatcher, workflows.DispatcherInput{
		Policy:   work.DefaultDispatcherPolicy(),
		CloneURL: "https://github.com/example/repository.git",
		Model:    work.Model{Name: "gpt-5", Effort: "high"},
	})
	if err != nil {
		t.Fatalf("starting target dispatcher: %v", err)
	}

	// The child cannot start until the wait activity completed and the parent
	// emitted its StartChildWorkflow command. Let both workflow tasks settle
	// before terminating the finite exported history.
	time.Sleep(time.Second)
	if err := server.Client().TerminateWorkflow(context.Background(), run.GetID(), run.GetRunID(), "fixture export"); err != nil {
		t.Fatalf("terminating target dispatcher: %v", err)
	}

	history := readTemporalHistory(t, server, run.GetID(), run.GetRunID())
	assertRepresentativeTargetDispatcherHistory(t, history)
	encoded, err := (temporalproto.CustomJSONMarshalOptions{Indent: "  "}).Marshal(history)
	if err != nil {
		t.Fatalf("encoding target dispatcher history: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(targetDispatcherHistoryFixture), 0o755); err != nil {
		t.Fatalf("creating fixture directory: %v", err)
	}
	if err := os.WriteFile(targetDispatcherHistoryFixture, append(encoded, '\n'), 0o600); err != nil {
		t.Fatalf("writing %s: %v", targetDispatcherHistoryFixture, err)
	}
}

func targetDispatcherFixtureChild(ctx workflow.Context, _ workflows.WorkOnTicketInput) error {
	workflow.GetLogger(ctx).Info("target dispatcher replay fixture child started")
	return workflow.Await(ctx, func() bool { return false })
}

func readTemporalHistory(t *testing.T, server *testsuite.DevServer, workflowID, runID string) *historypb.History {
	t.Helper()
	iterator := server.Client().GetWorkflowHistory(
		context.Background(),
		workflowID,
		runID,
		false,
		enums.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT,
	)
	history := &historypb.History{}
	for iterator.HasNext() {
		event, err := iterator.Next()
		if err != nil {
			t.Fatalf("reading legacy history: %v", err)
		}
		history.Events = append(history.Events, event)
	}
	if len(history.Events) == 0 {
		t.Fatal("legacy dispatcher history is empty")
	}
	return history
}
