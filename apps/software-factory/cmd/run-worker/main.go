// Command run-worker is the target per-Run Temporal Session worker. It polls
// exactly one generation-specific queue and hosts repository-affine activity
// implementations locally. Provisioning, Secret rotation, recording, and
// cleanup remain main-worker capabilities.
package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"go.temporal.io/sdk/activity"
	tlog "go.temporal.io/sdk/log"
	"go.temporal.io/sdk/worker"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/blobs"
	checkpointclient "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/checkpoint"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codex"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/local"
	temporalapi "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/temporal"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/config"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/prompts"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/telemetry"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/transcripts"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

const (
	runWorkerStopTimeout = 90 * time.Second
	transcriptsSubdir    = work.SandboxRoot + "/.transcripts"
)

func main() {
	if err := run(); err != nil {
		slog.New(slog.NewJSONHandler(os.Stderr, nil)).Error("the Run Worker stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.LoadRunWorker()
	if err != nil {
		return fmt.Errorf("reading Run Worker configuration: %w", err)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	blobStore, err := blobs.NewHTTPStore(cfg.BlobsURL, nil)
	if err != nil {
		return fmt.Errorf("opening HTTP blob store: %w", err)
	}
	temporal, err := temporalapi.Dial(temporalapi.Options{
		HostPort: cfg.TemporalHostPort, Namespace: cfg.TemporalNamespace,
		Logger: tlog.NewStructuredLogger(logger),
	}, blobStore, nil)
	if err != nil {
		return fmt.Errorf("dialling Temporal: %w", err)
	}
	defer temporal.Close()

	acts, targetActs, err := newActivities(cfg, logger)
	if err != nil {
		return err
	}
	w := worker.New(temporal, cfg.TaskQueue, worker.Options{
		WorkerStopTimeout:                  runWorkerStopTimeout,
		EnableSessionWorker:                true,
		MaxConcurrentSessionExecutionSize:  1,
		MaxConcurrentActivityExecutionSize: 1,
	})
	register(w, acts, targetActs)
	logger.Info("Run Worker starting", "run_worker", cfg.ID, "run_id", cfg.Identity.RunID,
		"generation", cfg.Identity.Generation, "task_queue", cfg.TaskQueue)
	if err := w.Run(worker.InterruptCh()); err != nil {
		return fmt.Errorf("running Run Worker %s: %w", cfg.ID, err)
	}
	return nil
}

func register(w worker.Worker, acts *activities.Activities, targetActs *activities.RunWorkerActivities) {
	w.RegisterActivity(acts.RunPlan)
	w.RegisterActivity(acts.RunImplement)
	w.RegisterActivity(acts.RunReview)
	w.RegisterActivity(targetActs)
}

func newActivities(cfg config.RunWorker, logger *slog.Logger) (*activities.Activities, *activities.RunWorkerActivities, error) {
	if err := os.MkdirAll(transcriptsSubdir, 0o750); err != nil {
		return nil, nil, fmt.Errorf("creating local transcript directory: %w", err)
	}
	sink, err := transcripts.New(transcriptsSubdir)
	if err != nil {
		return nil, nil, fmt.Errorf("building local transcript sink: %w", err)
	}
	if err := ensureCodexHome(work.CodexHomeDir, work.CodexAuthFile, work.RunWorkerCodexCredentialFile); err != nil {
		return nil, nil, fmt.Errorf("preparing Codex home: %w", err)
	}
	renderer, err := prompts.New(rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("building prompt renderer: %w", err)
	}
	runner := codex.NewRunner(local.NewExecer(), local.NewFileTransfer(), local.NewLocker(clock.System{}), logger)
	promptRenderer := prompts.NewActivityRenderer(renderer)
	legacy, err := activities.NewSandboxSide(activities.SandboxDeps{
		Stages:      runner,
		Transcripts: sink,
		Prompts:     promptRenderer,
		Metrics:     telemetry.NewMetrics(prometheus.NewRegistry()),
		Log:         logger,
		Clock:       clock.System{},
	})
	if err != nil {
		return nil, nil, fmt.Errorf("building legacy-compatible stage activities: %w", err)
	}
	checkpointFactory, err := checkpointclient.NewFactory(cfg.CheckpointAPIURL, work.RunWorkerCheckpointCapabilityFile, http.DefaultClient, os.ReadFile)
	if err != nil {
		return nil, nil, fmt.Errorf("building checkpoint client factory: %w", err)
	}
	providerState, err := codex.NewRolloutProbe(os.DirFS(work.CodexHomeDir))
	if err != nil {
		return nil, nil, fmt.Errorf("building Codex provider-state probe: %w", err)
	}
	target, err := activities.NewRunWorkerActivities(activities.RunWorkerDeps{
		Stages: runner, Prompts: promptRenderer,
		Checkpoints: func(id store.TargetAttemptID) (activities.AttemptCheckpoint, error) {
			return checkpointFactory.Open(id)
		},
		ProviderState: providerState, Clock: clock.System{}, Heartbeat: func(ctx context.Context) { activity.RecordHeartbeat(ctx) },
	})
	if err != nil {
		return nil, nil, fmt.Errorf("building target Run Worker activities: %w", err)
	}
	return legacy, target, nil
}

func ensureCodexHome(homeDir, authFile, projectedFile string) error {
	if err := os.MkdirAll(homeDir, 0o700); err != nil {
		return fmt.Errorf("creating %s: %w", homeDir, err)
	}
	switch target, err := os.Readlink(authFile); {
	case err == nil && target == projectedFile:
		return nil
	case err == nil:
		return fmt.Errorf("%s points at %s, not %s", authFile, target, projectedFile)
	case !errors.Is(err, os.ErrNotExist):
		return fmt.Errorf("checking %s: %w", authFile, err)
	}
	if err := os.Symlink(projectedFile, authFile); err != nil {
		return fmt.Errorf("linking %s to its projected credential: %w", authFile, err)
	}
	return nil
}
