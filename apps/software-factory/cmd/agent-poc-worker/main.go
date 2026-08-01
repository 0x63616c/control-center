// Command agent-poc-worker runs the isolated local direct-Codex Temporal worker.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agentpoc"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codexauth"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codexresponses"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/k8s"
	temporalapi "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/temporal"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/config"
	agentpocworkflow "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows/agentpoc"
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
	directSmokeModel := flag.String("direct-smoke-model", "", "run one direct subscription-backed smoke turn and exit")
	flag.Parse()
	config, err := config.LoadAgentPOCWorker()
	if err != nil {
		return fmt.Errorf("loading configuration: %w", err)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: config.LogLevel}))

	api, err := k8s.NewInClusterAPI()
	if err != nil {
		return fmt.Errorf("connecting to Kubernetes for the POC credential: %w", err)
	}
	store, err := k8s.NewSecretClient(api, config.PodNamespace, config.AuthSecretName, logger)
	if err != nil {
		return fmt.Errorf("constructing the POC credential store: %w", err)
	}
	refresher, err := codexauth.NewHTTPRefresher(
		&http.Client{Timeout: 30 * time.Second},
		codexauth.DefaultTokenURL,
		codexauth.DefaultClientID,
	)
	if err != nil {
		return fmt.Errorf("constructing the OAuth refresher: %w", err)
	}
	holder, err := credentialHolder(config.PodName)
	if err != nil {
		return fmt.Errorf("constructing the POC credential holder: %w", err)
	}
	managedSource, err := codexauth.New(store, refresher, clock.System{}, logger, holder, 2*time.Minute)
	if err != nil {
		return fmt.Errorf("constructing the durable POC credential source: %w", err)
	}
	if err := managedSource.Validate(context.Background()); err != nil {
		return fmt.Errorf("validating the durable POC credential source: %w", err)
	}
	credentialSource, err := codexresponses.NewManagedCredentialSource(managedSource)
	if err != nil {
		return fmt.Errorf("adapting the durable POC credential source: %w", err)
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
	if *directSmokeModel != "" {
		return directSmoke(turnClient, *directSmokeModel)
	}
	activities, err := agentpoc.NewActivities(turnClient, clock.System{})
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
	pocWorker.RegisterWorkflowWithOptions(agentpocworkflow.Workflow, workflow.RegisterOptions{Name: agentpoc.WorkflowName})
	pocWorker.RegisterActivityWithOptions(activities.ModelTurn, activity.RegisterOptions{Name: agentpoc.ModelTurnActivityName})
	pocWorker.RegisterActivityWithOptions(activities.Tool, activity.RegisterOptions{Name: agentpoc.ToolActivityName})
	logger.Info("agent POC worker polling", "task_queue", agentpoc.TaskQueue)
	if err := pocWorker.Run(worker.InterruptCh()); err != nil {
		return fmt.Errorf("running the Temporal worker: %w", err)
	}
	return nil
}

func credentialHolder(podName string) (string, error) {
	suffix := make([]byte, 4)
	if _, err := rand.Read(suffix); err != nil {
		return "", fmt.Errorf("reading random bytes: %w", err)
	}
	return podName + "/" + hex.EncodeToString(suffix), nil
}

func directSmoke(turnClient *codexresponses.Client, model string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	result, err := turnClient.Turn(ctx, codexresponses.TurnRequest{
		Model:         model,
		Instructions:  "This is a direct transport smoke test. Reply with DIRECT_OK and nothing else.",
		Input:         []codexresponses.InputItem{codexresponses.UserText("Run the direct transport smoke test.")},
		Store:         false,
		ToolChoice:    codexresponses.ToolChoiceNone,
		TextVerbosity: codexresponses.TextVerbosityLow,
	}, nil)
	if err != nil {
		return fmt.Errorf("running the direct Codex smoke turn: %w", err)
	}
	if result.Outcome != codexresponses.OutcomeFinalText || result.Text == "" {
		return fmt.Errorf("the direct Codex smoke turn returned outcome %q without final text", result.Outcome)
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		return fmt.Errorf("printing direct smoke evidence: %w", err)
	}
	return nil
}
