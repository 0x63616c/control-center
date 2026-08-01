// Command run-worker is the target per-Run Temporal Session worker. It polls
// exactly one generation-specific queue and hosts repository-affine activity
// implementations locally. Provisioning, Secret rotation, recording, and
// cleanup remain main-worker capabilities.
package main

import (
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	tlog "go.temporal.io/sdk/log"
	"go.temporal.io/sdk/worker"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/blobs"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codex"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/local"
	temporalapi "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/temporal"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/config"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/prompts"
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

	acts, err := newActivities(logger)
	if err != nil {
		return err
	}
	w := worker.New(temporal, cfg.TaskQueue, worker.Options{
		WorkerStopTimeout:                  runWorkerStopTimeout,
		EnableSessionWorker:                true,
		MaxConcurrentSessionExecutionSize:  1,
		MaxConcurrentActivityExecutionSize: 1,
	})
	register(w, acts)
	logger.Info("Run Worker starting", "run_worker", cfg.ID, "run_id", cfg.Identity.RunID,
		"generation", cfg.Identity.Generation, "task_queue", cfg.TaskQueue)
	if err := w.Run(worker.InterruptCh()); err != nil {
		return fmt.Errorf("running Run Worker %s: %w", cfg.ID, err)
	}
	return nil
}

func register(w worker.Worker, acts *activities.Activities) {
	w.RegisterActivity(acts.RunPlan)
	w.RegisterActivity(acts.RunImplement)
	w.RegisterActivity(acts.RunReview)
}

func newActivities(logger *slog.Logger) (*activities.Activities, error) {
	if err := os.MkdirAll(transcriptsSubdir, 0o750); err != nil {
		return nil, fmt.Errorf("creating local transcript directory: %w", err)
	}
	sink, err := transcripts.New(transcriptsSubdir)
	if err != nil {
		return nil, fmt.Errorf("building local transcript sink: %w", err)
	}
	if err := ensureCodexHome(work.CodexHomeDir, work.CodexAuthFile, work.RunWorkerCodexCredentialFile); err != nil {
		return nil, fmt.Errorf("preparing Codex home: %w", err)
	}
	renderer, err := prompts.New(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("building prompt renderer: %w", err)
	}
	return activities.NewSandboxSide(activities.SandboxDeps{
		Stages:      codex.NewRunner(local.NewExecer(), local.NewFileTransfer(), local.NewLocker(clock.System{}), logger),
		Transcripts: sink,
		Prompts:     prompts.NewActivityRenderer(renderer),
		Metrics:     telemetry.NewMetrics(prometheus.NewRegistry()),
		Log:         logger,
		Clock:       clock.System{},
	})
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
