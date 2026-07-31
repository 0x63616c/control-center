//go:build integration

package runworkercapability

import (
	"context"
	"fmt"
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

type sessionEvidence struct {
	First   string
	Second  string
	Control string
}

type sessionLossEvidence struct {
	First       string
	Failure     string
	Control     string
	Replacement string
}

func TestSessionPinsRepositoryWorkToItsPrivateWorker(t *testing.T) {
	server := startServer(t)

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
	}, sessionEvidenceWorkflow, privateQueueOne)
	if err != nil {
		t.Fatalf("starting workflow: %v", err)
	}

	var evidence sessionEvidence
	if err := run.Get(context.Background(), &evidence); err != nil {
		t.Fatalf("getting workflow result: %v", err)
	}

	if evidence.First != "private-one" || evidence.Second != "private-one" {
		t.Fatalf("session activities = %#v, want both on private-one", evidence)
	}
	if evidence.Control != "main-control" {
		t.Fatalf("main-control activity = %q, want main-control", evidence.Control)
	}
}

func TestSessionSurvivesAMainWorkerRestart(t *testing.T) {
	server := startServer(t)
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
	}, sessionRestartWorkflow, privateQueueOne)
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
	if evidence.First != "private-one" || evidence.Second != "private-one" || evidence.Control != "main-control" {
		t.Fatalf("evidence after main-worker restart = %#v", evidence)
	}
}

func TestSessionFailureLeavesMainControlAvailableForAReplacement(t *testing.T) {
	server := startServer(t)
	startWorker(t, mainCapabilityWorker(server.Client()))

	firstPrivateActivity := make(chan struct{}, 1)
	private := privateWorker(server.Client(), privateQueueOne, "private-one", firstPrivateActivity)
	if err := private.Start(); err != nil {
		t.Fatalf("starting initial private worker: %v", err)
	}

	run, err := server.Client().ExecuteWorkflow(context.Background(), client.StartWorkflowOptions{
		ID:        "session-capability-worker-loss",
		TaskQueue: mainQueue,
	}, sessionLossWorkflow, privateQueueOne, privateQueueTwo)
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
	if evidence.First != "private-one" || evidence.Replacement != "private-replacement" || evidence.Control != "main-control" {
		t.Fatalf("session-loss recovery evidence = %#v", evidence)
	}
	if evidence.Failure == "" {
		t.Fatal("lost private worker did not surface a Session failure")
	}
}

func sessionEvidenceWorkflow(ctx workflow.Context, privateQueue string) (sessionEvidence, error) {
	privateCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		TaskQueue:           privateQueue,
		StartToCloseTimeout: time.Minute,
	})
	sessionCtx, err := workflow.CreateSession(privateCtx, &workflow.SessionOptions{
		ExecutionTimeout: time.Minute,
		CreationTimeout:  time.Minute,
		HeartbeatTimeout: time.Second,
	})
	if err != nil {
		return sessionEvidence{}, fmt.Errorf("creating session: %w", err)
	}
	defer workflow.CompleteSession(sessionCtx)

	var result sessionEvidence
	if err := workflow.ExecuteActivity(sessionCtx, sessionActivityName).Get(sessionCtx, &result.First); err != nil {
		return sessionEvidence{}, fmt.Errorf("running first private activity: %w", err)
	}
	if err := workflow.ExecuteActivity(sessionCtx, sessionActivityName).Get(sessionCtx, &result.Second); err != nil {
		return sessionEvidence{}, fmt.Errorf("running second private activity: %w", err)
	}
	if err := workflow.ExecuteActivity(ctx, controlActivityName).Get(ctx, &result.Control); err != nil {
		return sessionEvidence{}, fmt.Errorf("running main-control activity: %w", err)
	}
	return result, nil
}

func sessionRestartWorkflow(ctx workflow.Context, privateQueue string) (sessionEvidence, error) {
	privateCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		TaskQueue:           privateQueue,
		StartToCloseTimeout: time.Minute,
	})
	sessionCtx, err := workflow.CreateSession(privateCtx, &workflow.SessionOptions{
		ExecutionTimeout: time.Minute,
		CreationTimeout:  time.Minute,
		HeartbeatTimeout: time.Second,
	})
	if err != nil {
		return sessionEvidence{}, fmt.Errorf("creating session: %w", err)
	}
	defer workflow.CompleteSession(sessionCtx)

	var result sessionEvidence
	if err := workflow.ExecuteActivity(sessionCtx, sessionActivityName).Get(sessionCtx, &result.First); err != nil {
		return sessionEvidence{}, fmt.Errorf("running first private activity: %w", err)
	}
	var continueRun string
	workflow.GetSignalChannel(ctx, "continue").Receive(ctx, &continueRun)
	if err := workflow.ExecuteActivity(sessionCtx, sessionActivityName).Get(sessionCtx, &result.Second); err != nil {
		return sessionEvidence{}, fmt.Errorf("running second private activity: %w", err)
	}
	if err := workflow.ExecuteActivity(ctx, controlActivityName).Get(ctx, &result.Control); err != nil {
		return sessionEvidence{}, fmt.Errorf("running main-control activity: %w", err)
	}
	return result, nil
}

func sessionLossWorkflow(ctx workflow.Context, firstQueue, replacementQueue string) (sessionLossEvidence, error) {
	firstCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		TaskQueue:           firstQueue,
		StartToCloseTimeout: time.Minute,
	})
	sessionCtx, err := workflow.CreateSession(firstCtx, &workflow.SessionOptions{
		ExecutionTimeout: time.Minute,
		CreationTimeout:  time.Minute,
		HeartbeatTimeout: time.Second,
	})
	if err != nil {
		return sessionLossEvidence{}, fmt.Errorf("creating initial session: %w", err)
	}
	defer workflow.CompleteSession(sessionCtx)

	var result sessionLossEvidence
	if err := workflow.ExecuteActivity(sessionCtx, sessionActivityName).Get(sessionCtx, &result.First); err != nil {
		return sessionLossEvidence{}, fmt.Errorf("running first private activity: %w", err)
	}
	var continueRun string
	workflow.GetSignalChannel(ctx, "continue").Receive(ctx, &continueRun)
	if err := workflow.ExecuteActivity(sessionCtx, sessionActivityName).Get(sessionCtx, nil); err == nil {
		return sessionLossEvidence{}, fmt.Errorf("lost Session unexpectedly accepted another activity")
	} else {
		result.Failure = err.Error()
	}
	if err := workflow.ExecuteActivity(ctx, controlActivityName).Get(ctx, &result.Control); err != nil {
		return sessionLossEvidence{}, fmt.Errorf("running main-control activity after Session loss: %w", err)
	}

	replacementCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		TaskQueue:           replacementQueue,
		StartToCloseTimeout: time.Minute,
	})
	replacementSession, err := workflow.CreateSession(replacementCtx, &workflow.SessionOptions{
		ExecutionTimeout: time.Minute,
		CreationTimeout:  time.Minute,
		HeartbeatTimeout: time.Second,
	})
	if err != nil {
		return sessionLossEvidence{}, fmt.Errorf("creating replacement session: %w", err)
	}
	defer workflow.CompleteSession(replacementSession)
	if err := workflow.ExecuteActivity(replacementSession, sessionActivityName).Get(replacementSession, &result.Replacement); err != nil {
		return sessionLossEvidence{}, fmt.Errorf("running replacement private activity: %w", err)
	}
	return result, nil
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
		func(context.Context) (string, error) {
			if started != nil {
				once.Do(func() { started <- struct{}{} })
			}
			return identity, nil
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
