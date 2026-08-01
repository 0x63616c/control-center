// Command agent-poc-worker runs the isolated local direct-Codex Temporal worker.
package main

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agentpoc"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codexauth"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codexresponses"
	temporalapi "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/temporal"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/config"
	"go.temporal.io/sdk/activity"
	tlog "go.temporal.io/sdk/log"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

func main() {
	if err := run(); err != nil {
		slog.New(slog.NewJSONHandler(os.Stderr, nil)).Error("the agent POC worker stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	config, err := config.LoadAgentPOCWorker()
	if err != nil {
		return fmt.Errorf("loading configuration: %w", err)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: config.LogLevel}))

	refresher, err := codexauth.NewHTTPRefresher(
		&http.Client{Timeout: 30 * time.Second},
		codexauth.DefaultTokenURL,
		codexauth.DefaultClientID,
	)
	if err != nil {
		return fmt.Errorf("constructing the OAuth refresher: %w", err)
	}
	credentialSource, err := codexresponses.NewFileCredentialSource(
		config.AuthFile,
		refresher,
		clock.System{},
		5*time.Minute,
	)
	if err != nil {
		return fmt.Errorf("constructing the credential source: %w", err)
	}
	turnClient, err := codexresponses.New(
		&http.Client{Timeout: 110 * time.Second},
		config.ResponsesEndpoint,
		credentialSource,
		logger,
	)
	if err != nil {
		return fmt.Errorf("constructing the direct Codex client: %w", err)
	}
	activities, err := agentpoc.NewActivities(turnClient)
	if err != nil {
		return fmt.Errorf("constructing activities: %w", err)
	}

	temporal, err := temporalapi.Dial(temporalapi.Options{
		HostPort:  config.TemporalHostPort,
		Namespace: config.TemporalNamespace,
		Logger:    tlog.NewStructuredLogger(logger),
	}, nil, nil)
	if err != nil {
		return fmt.Errorf("dialling Temporal: %w", err)
	}
	defer temporal.Close()

	pocWorker := worker.New(temporal, agentpoc.TaskQueue, worker.Options{
		MaxConcurrentActivityExecutionSize: 1,
		WorkerStopTimeout:                  20 * time.Second,
	})
	pocWorker.RegisterWorkflowWithOptions(agentpoc.Workflow, workflow.RegisterOptions{Name: agentpoc.WorkflowName})
	pocWorker.RegisterActivityWithOptions(activities.ModelTurn, activity.RegisterOptions{Name: agentpoc.ModelTurnActivityName})
	pocWorker.RegisterActivityWithOptions(activities.Tool, activity.RegisterOptions{Name: agentpoc.ToolActivityName})
	logger.Info("agent POC worker polling", "task_queue", agentpoc.TaskQueue)
	if err := pocWorker.Run(worker.InterruptCh()); err != nil {
		return fmt.Errorf("running the Temporal worker: %w", err)
	}
	return nil
}
