// Command sandbox-worker is the Temporal worker embedded in a per-ticket
// sandbox pod. It polls only that run's Session queue and exposes one generic,
// typed agent tool activity. Model calls and credentials stay on the main
// worker; this process only reads or mutates the checked-out repository.
//
// It is a separate binary from cmd/worker, not a role flag on it, for three
// reasons settled in #434's addendum (D2): acceptance criterion 4 greps this
// file for the workflow-registration call and expects nothing, which is a
// structural guarantee a flag can only claim conditionally; the two images
// that carry these binaries are already
// separate (images/worker, images/sandbox), so one binary buys no packaging
// benefit; and it makes "registers activities only" true by construction
// rather than by a runtime check nobody is forced to keep honouring. The cost
// — some composition-root wiring duplicated from cmd/worker (logging,
// crypto/rand for the prompt renderer) — is accepted; each piece is a few
// lines, and cmd/ binaries cannot import one another's `package main`.
package main

import (
	"fmt"
	"log/slog"
	"os"
	"time"

	"go.temporal.io/sdk/activity"
	tlog "go.temporal.io/sdk/log"
	"go.temporal.io/sdk/worker"

	agentactivities "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agenttools"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/blobs"
	temporalapi "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/temporal"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/config"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// workerStopTimeout is how long a drain waits for RunStage to finish after a
// SIGTERM, mirroring cmd/worker's own constant and its reasoning: a stage may
// run for work.MaxStageDuration (60m) and no deploy waits an hour, so a stage
// in flight when this pod is asked to stop IS cancelled — see
// internal/clients/local.Execer's doc comment on Exec for what that
// cancellation actually does now (kills the real child process directly,
// unlike the remote transport this replaces).
//
// UNVERIFIED against a real pod: whether this needs to relate to the sandbox
// pod's own terminationGracePeriodSeconds the way cmd/worker's constant
// relates to the main worker Deployment's — that wiring is deploy-side
// (podspec.go / a later slice), not decided here.
const workerStopTimeout = 90 * time.Second

func main() {
	if err := run(); err != nil {
		slog.New(slog.NewJSONHandler(os.Stderr, nil)).
			Error("the sandbox worker stopped", slog.String("error", err.Error()))
		os.Exit(1)
	}
}

// run builds the process and blocks until it drains.
func run() error {
	cfg, err := config.LoadSandboxWorker()
	if err != nil {
		return fmt.Errorf("reading the sandbox worker's configuration: %w", err)
	}
	logger := newLogger(cfg.LogLevel)
	blobStore, err := blobs.NewHTTPStore(cfg.BlobsURL, nil)
	if err != nil {
		return fmt.Errorf("opening HTTP blob store: %w", err)
	}

	temporal, err := temporalapi.Dial(temporalapi.Options{
		HostPort:  cfg.TemporalHostPort,
		Namespace: cfg.TemporalNamespace,
		Logger:    tlog.NewStructuredLogger(logger),
	}, blobStore, nil)
	if err != nil {
		return fmt.Errorf("dialling Temporal at %s in namespace %s: %w", cfg.TemporalHostPort, cfg.TemporalNamespace, err)
	}
	defer temporal.Close()

	w := worker.New(temporal, cfg.TaskQueue, worker.Options{
		WorkerStopTimeout: workerStopTimeout,

		// The two options that make this pod eligible to HOST a session, and
		// bound it to exactly one at a time — D1's "a pod serves one ticket
		// at a time" and B3's "exactly one CreateSession per ticket run" are
		// both properties of THIS worker instance, not of the cluster.
		EnableSessionWorker:               true,
		MaxConcurrentSessionExecutionSize: 1,
		// This serialises duplicate activity delivery against this pod's mutable
		// stage directory; it is a guard, not a throughput setting.
		MaxConcurrentActivityExecutionSize: 1,
	})

	toolsets, err := agenttools.NewToolsets(work.RepoDir, "sandbox/"+cfg.TaskQueue, blobStore)
	if err != nil {
		return fmt.Errorf("building the sandbox agent toolsets: %w", err)
	}
	toolActivities, err := agentactivities.NewToolActivities(blobStore, toolsets...)
	if err != nil {
		return fmt.Errorf("building the sandbox agent activity: %w", err)
	}

	register(w, toolActivities, logger)

	logger.Info("sandbox worker starting",
		slog.String("task_queue", cfg.TaskQueue),
		slog.String("temporal_namespace", cfg.TemporalNamespace),
	)

	if err := w.Run(worker.InterruptCh()); err != nil {
		return fmt.Errorf("running the sandbox worker on task queue %s: %w", cfg.TaskQueue, err)
	}
	logger.Info("sandbox worker drained")
	return nil
}

// register exposes only the generic typed tool boundary. The child workflow
// selects an immutable toolset; this worker never runs workflows or model
// activities and cannot recover the provider credential.
func register(w worker.Worker, tools *agentactivities.ToolActivities, logger *slog.Logger) {
	w.RegisterActivityWithOptions(tools.Tool, activity.RegisterOptions{Name: agent.ToolActivityName})

	logger.Info("registrations",
		slog.Int("workflows", 0),
		slog.Int("activities", 1),
	)
}

// newLogger is this process's one logger: JSON on stdout, matching
// cmd/worker's own so the cluster's Loki pipeline picks up both the same way.
func newLogger(level slog.Level) *slog.Logger {
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
}
