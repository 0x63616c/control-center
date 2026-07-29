// Command worker runs the software factory: a Temporal worker that polls for
// GitHub issues labelled `auto` and takes them from idea to open pull request.
//
// This file is the composition root, and it is the only place in the service
// where a concrete client meets an interface that consumes it. Construction is
// manual and explicit — no container, no reflection, no init() — so what the
// process is made of is what is written here, top to bottom, and a test
// elsewhere can hand any of it a fake.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"go.temporal.io/sdk/client"
	tlog "go.temporal.io/sdk/log"
	"go.temporal.io/sdk/worker"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/config"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/prompts"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// shutdownGrace bounds how long the metrics server is given to finish in-flight
// scrapes once the worker has drained. It is short because nothing important
// happens over HTTP here: the work is on the task queue.
const shutdownGrace = 5 * time.Second

// workerStopTimeout is how long a drain waits for in-flight activities after a
// SIGTERM. It must be set explicitly: worker.Options{} leaves it at the SDK's
// zero value, and a zero timeout is not "wait forever" — awaitWaitGroup starts
// an already-fired timer, so the drain returns immediately, logs "graceful stop
// timed out" and cancels every activity context. That is the opposite of a
// drain, and it is what this file used to do while claiming otherwise.
//
// It is deliberately far shorter than a stage. A stage may run for
// work.MaxStageDuration (60m) and no deploy waits an hour, so a stage in flight
// when the worker stops IS cancelled — that is the honest behaviour, and
// ADR-0011's idempotent-stage design is what makes it affordable: the next
// attempt finds the result file or the live process and reattaches rather than
// paying for the work twice. What this window buys is the short activities
// either side of a stage — a GitHub comment, a transcript write, a credential
// rotation mid-flight — finishing instead of being torn in half.
//
// The relationship that matters is with the pod's grace period, not with the
// stage timeout: terminationGracePeriodSeconds must exceed this plus
// shutdownGrace, or the kubelet SIGKILLs the drain it is waiting for. F1 sets
// 120s (infra/src/software-factory.ts, TERMINATION_GRACE_SECONDS), which leaves
// 25s of headroom. TestTheDrainFitsInsideThePodsGracePeriod is what stops
// either number moving alone.
const workerStopTimeout = 90 * time.Second

func main() {
	if err := run(); err != nil {
		// The process may have failed before it had a configured logger, so
		// this one is built on the spot. It is the only logger in the service
		// that is not the injected one, and it exists for exactly this line.
		slog.New(slog.NewJSONHandler(os.Stderr, nil)).
			Error("the worker stopped", slog.String("error", err.Error()))
		os.Exit(1)
	}
}

// run builds the process and blocks until it drains.
//
// It returns an error rather than exiting, so every failure leaves through one
// path and main stays a place where nothing can hide.
func run() error {
	cfg, err := config.LoadWorker()
	if err != nil {
		return fmt.Errorf("reading the worker's configuration: %w", err)
	}

	logger := newLogger(cfg.LogLevel)
	bridgeKlog(logger)

	// Read at startup rather than by the dispatcher itself, so a configuration
	// nobody can run crashloops the pod with the reason in its logs. The same
	// JSON arriving later as an UpdateConfig signal has no way to fail back to
	// whoever sent it, which makes startup the one place this can be loud.
	dispatcher, err := config.LoadDispatcher()
	if err != nil {
		return fmt.Errorf("reading the dispatcher's configuration: %w", err)
	}

	// The one metrics registry in this process. Prometheus panics on a
	// duplicate registration, deliberately, so a second registry or a second
	// construction of the metrics that record into it is a crash in
	// production; that is why both live here and are passed down.
	registry := prometheus.NewRegistry()
	registry.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)

	// Bound before the worker starts, so a port already in use is a startup
	// failure with a clear message rather than a worker that runs unmonitored.
	listener, err := net.Listen("tcp", cfg.MetricsAddr)
	if err != nil {
		return fmt.Errorf("listening for metrics on %s (METRICS_ADDR): %w", cfg.MetricsAddr, err)
	}
	server := &http.Server{
		Handler:           observability(registry),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("the metrics server stopped", slog.String("error", err.Error()))
		}
	}()
	defer stopServer(server, logger)

	temporal, err := client.Dial(client.Options{
		HostPort:  cfg.TemporalHostPort,
		Namespace: cfg.TemporalNamespace,
		Logger:    tlog.NewStructuredLogger(logger),
	})
	if err != nil {
		return fmt.Errorf("dialling Temporal at %s in namespace %s: %w", cfg.TemporalHostPort, cfg.TemporalNamespace, err)
	}
	defer temporal.Close()

	w := worker.New(temporal, cfg.TaskQueue, worker.Options{
		WorkerStopTimeout: workerStopTimeout,
	})

	// Registration site. The dispatcher and WorkTicket workflows (C1, C2) and
	// the activities that carry out a stage are registered here, on this
	// worker, and nowhere else — one queue, one worker, one list. Nothing is
	// registered yet: this worker polls and finds nothing to do, which is the
	// honest state of the system until those tracks land.
	renderer, err := newPromptRenderer()
	if err != nil {
		return err
	}
	register(w, renderer, dispatcher, logger)

	logger.Info("worker starting",
		slog.String("task_queue", cfg.TaskQueue),
		slog.String("temporal_namespace", cfg.TemporalNamespace),
		slog.String("sandbox_namespace", cfg.SandboxNamespace),
		slog.String("pod", cfg.PodName),
		// What the dispatcher will run under, logged where it was read: the
		// question asked of a live system is "did my config land", and this is
		// the first of the two places that can answer it. The other is the
		// GetStatus query, once C2 lands.
		slog.Bool("dispatcher_paused", dispatcher.Paused),
		slog.Int("dispatcher_max_in_flight", dispatcher.MaxInFlight),
		slog.Int64("dispatcher_breaker_cooldown_seconds", dispatcher.BreakerCooldownSeconds),
		slog.String("dispatcher_default_model", dispatcher.DefaultModel.Name),
	)

	// Run blocks until SIGINT or SIGTERM, then drains: no new tasks are taken,
	// and in-flight activities get workerStopTimeout to finish before their
	// contexts are cancelled. A stage will not finish in that window and is not
	// meant to — see workerStopTimeout. Sandbox pods are deliberately left
	// behind — they are independent objects, and a restarted worker reattaches
	// to the attempt it left running rather than paying for it twice.
	if err := w.Run(worker.InterruptCh()); err != nil {
		return fmt.Errorf("running the worker on task queue %s: %w", cfg.TaskQueue, err)
	}
	logger.Info("worker drained")
	return nil
}

// register puts this worker's workflows and activities on its task queue.
//
// One function, one call site: a registration list that grew in two places
// would be a queue serving a set of workflows nobody can enumerate. Nothing is
// registered yet — C1's WorkTicket and C2's dispatcher, and the activities they
// call, land here.
//
// The renderer is a parameter rather than something this builds, because it
// belongs to the activity that runs a stage and must never reach workflow code:
// a replayed workflow that re-rendered a prompt would mint a fresh fence nonce
// and diverge from its own history. That is what internal/prompts' place on the
// workflows-are-deterministic deny list enforces, and what this signature says.
func register(w worker.Worker, renderer *prompts.Renderer, dispatcher work.Config, logger *slog.Logger) {
	logger.Info("registrations",
		slog.Int("workflows", 0),
		slog.Int("activities", 0),
		slog.Int("stages_per_ticket", len(work.Pipeline())),
		slog.Int("max_in_flight", dispatcher.MaxInFlight),
	)
}

// stopServer gives in-flight scrapes a moment to finish. Its failure is logged
// rather than returned: the worker has already drained by the time this runs,
// and a metrics server that would not close is not a reason to report the run
// as failed.
func stopServer(server *http.Server, logger *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		logger.Warn("the metrics server did not shut down cleanly", slog.String("error", err.Error()))
	}
}
