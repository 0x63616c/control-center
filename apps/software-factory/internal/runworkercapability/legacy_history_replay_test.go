package runworkercapability

import (
	"context"
	"flag"
	"os"
	"path/filepath"
	"testing"
	"time"

	enums "go.temporal.io/api/enums/v1"
	historypb "go.temporal.io/api/history/v1"
	"go.temporal.io/api/temporalproto"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/worker"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
)

var updateLegacyHistory = flag.Bool("update-legacy-history", false, "replace the checked-in legacy dispatcher history fixture")

const legacyHistoryFixture = "../workflows/testdata/factory-dispatcher-paused.json"

func TestLegacyFactoryDispatcherHistoryReplays(t *testing.T) {
	if *updateLegacyHistory {
		writeLegacyHistoryFixture(t)
	}

	replayer := worker.NewWorkflowReplayer()
	replayer.RegisterWorkflow(workflows.FactoryDispatcher)
	if err := replayer.ReplayWorkflowHistoryFromJSONFile(nil, legacyHistoryFixture); err != nil {
		t.Fatalf("replaying %s through the unchanged FactoryDispatcher registration: %v", legacyHistoryFixture, err)
	}
}

func writeLegacyHistoryFixture(t *testing.T) {
	t.Helper()
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
	w := worker.New(server.Client(), queue, worker.Options{})
	w.RegisterWorkflow(workflows.FactoryDispatcher)
	w.RegisterActivityWithOptions(
		func(context.Context, activities.SweepInput) (activities.SweepResult, error) {
			return activities.SweepResult{}, nil
		},
		activity.RegisterOptions{Name: "Activities.SweepOrphanSandboxes"},
	)
	if err := w.Start(); err != nil {
		t.Fatalf("starting legacy worker: %v", err)
	}
	t.Cleanup(w.Stop)

	config := work.DefaultFactoryConfig()
	config.Paused = true
	run, err := server.Client().ExecuteWorkflow(context.Background(), client.StartWorkflowOptions{
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
	waitForLegacyCommand(t, server.Client(), run.GetID(), run.GetRunID())

	if err := server.Client().TerminateWorkflow(context.Background(), run.GetID(), run.GetRunID(), "fixture export"); err != nil {
		t.Fatalf("terminating legacy dispatcher: %v", err)
	}

	history := readHistory(t, server.Client(), run.GetID(), run.GetRunID())
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

func waitForLegacyCommand(t *testing.T, c client.Client, workflowID, runID string) {
	t.Helper()
	timeout := time.NewTimer(10 * time.Second)
	defer timeout.Stop()
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()

	for {
		for _, event := range readHistory(t, c, workflowID, runID).Events {
			if event.GetActivityTaskScheduledEventAttributes() != nil {
				return
			}
		}
		select {
		case <-timeout.C:
			t.Fatal("legacy dispatcher did not schedule a command before fixture export")
		case <-tick.C:
		}
	}
}

func readHistory(t *testing.T, c client.Client, workflowID, runID string) *historypb.History {
	t.Helper()
	iterator := c.GetWorkflowHistory(context.Background(), workflowID, runID, false, enums.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT)
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
