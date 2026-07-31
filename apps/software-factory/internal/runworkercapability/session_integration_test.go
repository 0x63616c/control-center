//go:build integration

package runworkercapability

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

const (
	mainQueue       = "capability-main"
	privateQueueOne = "capability-private-one"
	privateQueueTwo = "capability-private-two"

	sessionActivityName = "capability-session-activity"
	controlActivityName = "capability-control-activity"
)

type sessionActivityInput struct {
	MarkerPath string
	Marker     string
	Write      bool
}

type sessionActivityEvidence struct {
	Worker string
	Marker string
}

type sessionWorkflowInput struct {
	PrivateQueue string
	MarkerPath   string
	Marker       string
}

type sessionEvidence struct {
	First   sessionActivityEvidence
	Second  sessionActivityEvidence
	Control string
}

type sessionLossInput struct {
	FirstQueue            string
	ReplacementQueue      string
	FirstMarkerPath       string
	ReplacementMarkerPath string
	Marker                string
}

type sessionLossEvidence struct {
	First       sessionActivityEvidence
	Failure     string
	Control     string
	Replacement sessionActivityEvidence
}

func TestSessionPinsRepositoryWorkToItsPrivateWorker(t *testing.T) {
	server := startServer(t)
	markerPath := filepath.Join(t.TempDir(), "repository.marker")

	mainWorker := worker.New(server.Client(), mainQueue, worker.Options{})
	mainWorker.RegisterWorkflow(sessionEvidenceWorkflow)
	mainWorker.RegisterActivityWithOptions(
		func(context.Context) (string, error) { return "main-control", nil },
		activity.RegisterOptions{Name: controlActivityName},
	)
	startWorker(t, mainWorker)

	privateOne := privateWorker(server.Client(), privateQueueOne, "private-one", nil)
	privateTwo := privateWorker(server.Client(), privateQueueTwo, "private-two", nil)
	startWorker(t, privateOne)
	startWorker(t, privateTwo)

	run, err := server.Client().ExecuteWorkflow(context.Background(), client.StartWorkflowOptions{
		ID:        "session-capability-affinity",
		TaskQueue: mainQueue,
	}, sessionEvidenceWorkflow, sessionWorkflowInput{
		PrivateQueue: privateQueueOne,
		MarkerPath:   markerPath,
		Marker:       "repository-state-v1",
	})
	if err != nil {
		t.Fatalf("starting workflow: %v", err)
	}

	var evidence sessionEvidence
	if err := run.Get(context.Background(), &evidence); err != nil {
		t.Fatalf("getting workflow result: %v", err)
	}

	if evidence.First.Worker != "private-one" || evidence.Second.Worker != "private-one" {
		t.Fatalf("session activities = %#v, want both on private-one", evidence)
	}
	if evidence.First.Marker != "repository-state-v1" || evidence.Second.Marker != "repository-state-v1" {
		t.Fatalf("filesystem marker evidence = %#v, want both activities to observe repository-state-v1", evidence)
	}
	if evidence.Control != "main-control" {
		t.Fatalf("main-control activity = %q, want main-control", evidence.Control)
	}
}

func TestSessionSurvivesAMainWorkerRestart(t *testing.T) {
	server := startServer(t)
	markerPath := filepath.Join(t.TempDir(), "repository.marker")
	mainWorker := mainCapabilityWorker(server.Client())
	if err := mainWorker.Start(); err != nil {
		t.Fatalf("starting initial main worker: %v", err)
	}

	firstPrivateActivity := make(chan struct{}, 1)
	private := privateWorker(server.Client(), privateQueueOne, "private-one", firstPrivateActivity)
	startWorker(t, private)

	run, err := server.Client().ExecuteWorkflow(context.Background(), client.StartWorkflowOptions{
		ID:        "session-capability-main-restart",
		TaskQueue: mainQueue,
	}, sessionRestartWorkflow, sessionWorkflowInput{
		PrivateQueue: privateQueueOne,
		MarkerPath:   markerPath,
		Marker:       "repository-state-v1",
	})
	if err != nil {
		t.Fatalf("starting workflow: %v", err)
	}
	select {
	case <-firstPrivateActivity:
	case <-time.After(10 * time.Second):
		t.Fatal("first private activity did not complete")
	}

	mainWorker.Stop()
	replacement := mainCapabilityWorker(server.Client())
	startWorker(t, replacement)
	if err := server.Client().SignalWorkflow(context.Background(), run.GetID(), run.GetRunID(), "continue", "resume"); err != nil {
		t.Fatalf("signalling workflow after main-worker restart: %v", err)
	}

	var evidence sessionEvidence
	if err := run.Get(context.Background(), &evidence); err != nil {
		t.Fatalf("getting workflow result: %v", err)
	}
	if evidence.First.Worker != "private-one" || evidence.Second.Worker != "private-one" ||
		evidence.First.Marker != "repository-state-v1" || evidence.Second.Marker != "repository-state-v1" ||
		evidence.Control != "main-control" {
		t.Fatalf("evidence after main-worker restart = %#v", evidence)
	}
}

func TestSessionFailureLeavesMainControlAvailableForAReplacement(t *testing.T) {
	server := startServer(t)
	markerDir := t.TempDir()
	startWorker(t, mainCapabilityWorker(server.Client()))

	firstPrivateActivity := make(chan struct{}, 1)
	private := privateWorker(server.Client(), privateQueueOne, "private-one", firstPrivateActivity)
	if err := private.Start(); err != nil {
		t.Fatalf("starting initial private worker: %v", err)
	}

	run, err := server.Client().ExecuteWorkflow(context.Background(), client.StartWorkflowOptions{
		ID:        "session-capability-worker-loss",
		TaskQueue: mainQueue,
	}, sessionLossWorkflow, sessionLossInput{
		FirstQueue:            privateQueueOne,
		ReplacementQueue:      privateQueueTwo,
		FirstMarkerPath:       filepath.Join(markerDir, "first.marker"),
		ReplacementMarkerPath: filepath.Join(markerDir, "replacement.marker"),
		Marker:                "repository-state-v1",
	})
	if err != nil {
		t.Fatalf("starting workflow: %v", err)
	}
	select {
	case <-firstPrivateActivity:
	case <-time.After(10 * time.Second):
		t.Fatal("first private activity did not complete")
	}

	private.Stop()
	startWorker(t, privateWorker(server.Client(), privateQueueTwo, "private-replacement", nil))
	if err := server.Client().SignalWorkflow(context.Background(), run.GetID(), run.GetRunID(), "continue", "resume"); err != nil {
		t.Fatalf("signalling workflow after private-worker loss: %v", err)
	}

	var evidence sessionLossEvidence
	if err := run.Get(context.Background(), &evidence); err != nil {
		t.Fatalf("getting workflow result: %v", err)
	}
	if evidence.First.Worker != "private-one" || evidence.Replacement.Worker != "private-replacement" ||
		evidence.First.Marker != "repository-state-v1" || evidence.Replacement.Marker != "repository-state-v1" ||
		evidence.Control != "main-control" {
		t.Fatalf("session-loss recovery evidence = %#v", evidence)
	}
	if evidence.Failure == "" {
		t.Fatal("lost private worker did not surface a Session failure")
	}
}

func sessionEvidenceWorkflow(ctx workflow.Context, in sessionWorkflowInput) (sessionEvidence, error) {
	sessionCtx, err := createCapabilitySession(ctx, in.PrivateQueue)
	if err != nil {
		return sessionEvidence{}, fmt.Errorf("creating session: %w", err)
	}
	defer workflow.CompleteSession(sessionCtx)

	var result sessionEvidence
	first := sessionActivityInput{MarkerPath: in.MarkerPath, Marker: in.Marker, Write: true}
	if err := workflow.ExecuteActivity(sessionCtx, sessionActivityName, first).Get(sessionCtx, &result.First); err != nil {
		return sessionEvidence{}, fmt.Errorf("running first private activity: %w", err)
	}
	second := sessionActivityInput{MarkerPath: in.MarkerPath, Marker: in.Marker}
	if err := workflow.ExecuteActivity(sessionCtx, sessionActivityName, second).Get(sessionCtx, &result.Second); err != nil {
		return sessionEvidence{}, fmt.Errorf("running second private activity: %w", err)
	}
	if err := workflow.ExecuteActivity(ctx, controlActivityName).Get(ctx, &result.Control); err != nil {
		return sessionEvidence{}, fmt.Errorf("running main-control activity: %w", err)
	}
	return result, nil
}

func sessionRestartWorkflow(ctx workflow.Context, in sessionWorkflowInput) (sessionEvidence, error) {
	sessionCtx, err := createCapabilitySession(ctx, in.PrivateQueue)
	if err != nil {
		return sessionEvidence{}, fmt.Errorf("creating session: %w", err)
	}
	defer workflow.CompleteSession(sessionCtx)

	var result sessionEvidence
	first := sessionActivityInput{MarkerPath: in.MarkerPath, Marker: in.Marker, Write: true}
	if err := workflow.ExecuteActivity(sessionCtx, sessionActivityName, first).Get(sessionCtx, &result.First); err != nil {
		return sessionEvidence{}, fmt.Errorf("running first private activity: %w", err)
	}
	var continueRun string
	workflow.GetSignalChannel(ctx, "continue").Receive(ctx, &continueRun)
	second := sessionActivityInput{MarkerPath: in.MarkerPath, Marker: in.Marker}
	if err := workflow.ExecuteActivity(sessionCtx, sessionActivityName, second).Get(sessionCtx, &result.Second); err != nil {
		return sessionEvidence{}, fmt.Errorf("running second private activity: %w", err)
	}
	if err := workflow.ExecuteActivity(ctx, controlActivityName).Get(ctx, &result.Control); err != nil {
		return sessionEvidence{}, fmt.Errorf("running main-control activity: %w", err)
	}
	return result, nil
}

func sessionLossWorkflow(ctx workflow.Context, in sessionLossInput) (sessionLossEvidence, error) {
	sessionCtx, err := createCapabilitySession(ctx, in.FirstQueue)
	if err != nil {
		return sessionLossEvidence{}, fmt.Errorf("creating initial session: %w", err)
	}
	defer workflow.CompleteSession(sessionCtx)

	var result sessionLossEvidence
	first := sessionActivityInput{MarkerPath: in.FirstMarkerPath, Marker: in.Marker, Write: true}
	if err := workflow.ExecuteActivity(sessionCtx, sessionActivityName, first).Get(sessionCtx, &result.First); err != nil {
		return sessionLossEvidence{}, fmt.Errorf("running first private activity: %w", err)
	}
	var continueRun string
	workflow.GetSignalChannel(ctx, "continue").Receive(ctx, &continueRun)
	read := sessionActivityInput{MarkerPath: in.FirstMarkerPath, Marker: in.Marker}
	if err := workflow.ExecuteActivity(sessionCtx, sessionActivityName, read).Get(sessionCtx, nil); err == nil {
		return sessionLossEvidence{}, fmt.Errorf("lost Session unexpectedly accepted another activity")
	} else {
		result.Failure = err.Error()
	}
	if err := workflow.ExecuteActivity(ctx, controlActivityName).Get(ctx, &result.Control); err != nil {
		return sessionLossEvidence{}, fmt.Errorf("running main-control activity after Session loss: %w", err)
	}

	replacementSession, err := createCapabilitySession(ctx, in.ReplacementQueue)
	if err != nil {
		return sessionLossEvidence{}, fmt.Errorf("creating replacement session: %w", err)
	}
	defer workflow.CompleteSession(replacementSession)
	replacement := sessionActivityInput{MarkerPath: in.ReplacementMarkerPath, Marker: in.Marker, Write: true}
	if err := workflow.ExecuteActivity(replacementSession, sessionActivityName, replacement).Get(replacementSession, &result.Replacement); err != nil {
		return sessionLossEvidence{}, fmt.Errorf("running replacement private activity: %w", err)
	}
	return result, nil
}

func createCapabilitySession(ctx workflow.Context, privateQueue string) (workflow.Context, error) {
	privateCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		TaskQueue:           privateQueue,
		StartToCloseTimeout: time.Minute,
	})
	return workflow.CreateSession(privateCtx, &workflow.SessionOptions{
		ExecutionTimeout: time.Minute,
		CreationTimeout:  time.Minute,
		HeartbeatTimeout: time.Second,
	})
}

func mainCapabilityWorker(c client.Client) worker.Worker {
	w := worker.New(c, mainQueue, worker.Options{})
	w.RegisterWorkflow(sessionEvidenceWorkflow)
	w.RegisterWorkflow(sessionRestartWorkflow)
	w.RegisterWorkflow(sessionLossWorkflow)
	w.RegisterActivityWithOptions(
		func(context.Context) (string, error) { return "main-control", nil },
		activity.RegisterOptions{Name: controlActivityName},
	)
	return w
}

func privateWorker(c client.Client, queue, identity string, started chan<- struct{}) worker.Worker {
	w := worker.New(c, queue, worker.Options{
		EnableSessionWorker:               true,
		MaxConcurrentSessionExecutionSize: 1,
	})
	var once sync.Once
	w.RegisterActivityWithOptions(
		func(_ context.Context, in sessionActivityInput) (sessionActivityEvidence, error) {
			if started != nil {
				once.Do(func() { started <- struct{}{} })
			}
			if in.Write {
				if err := os.WriteFile(in.MarkerPath, []byte(in.Marker), 0o600); err != nil {
					return sessionActivityEvidence{}, fmt.Errorf("writing filesystem marker: %w", err)
				}
			}
			marker, err := os.ReadFile(in.MarkerPath)
			if err != nil {
				return sessionActivityEvidence{}, fmt.Errorf("reading filesystem marker: %w", err)
			}
			return sessionActivityEvidence{Worker: identity, Marker: string(marker)}, nil
		},
		activity.RegisterOptions{Name: sessionActivityName},
	)
	return w
}

func startServer(t *testing.T) *testsuite.DevServer {
	t.Helper()
	server, err := testsuite.StartDevServer(context.Background(), testsuite.DevServerOptions{
		CachedDownload: testsuite.CachedDownload{Version: "v1.8.1"},
		LogLevel:       "error",
	})
	if err != nil {
		t.Fatalf("starting Temporal dev server: %v", err)
	}
	t.Cleanup(func() {
		if err := server.Stop(); err != nil {
			t.Errorf("stopping Temporal dev server: %v", err)
		}
	})
	return server
}

func startWorker(t *testing.T, w worker.Worker) {
	t.Helper()
	if err := w.Start(); err != nil {
		t.Fatalf("starting worker: %v", err)
	}
	t.Cleanup(w.Stop)
}
