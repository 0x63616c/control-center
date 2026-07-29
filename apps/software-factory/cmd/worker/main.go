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
)

// shutdownGrace bounds how long the metrics server is given to finish in-flight
// scrapes once the worker has drained. It is short because nothing important
// happens over HTTP here: the work is on the task queue.
const shutdownGrace = 5 * time.Second

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

	w := worker.New(temporal, cfg.TaskQueue, worker.Options{})

	// Registration site. The dispatcher and WorkTicket workflows (C1, C2) and
	// the activities that carry out a stage (B5) are registered here, on this
	// worker, and nowhere else — one queue, one worker, one list. Nothing is
	// registered yet: this worker polls and finds nothing to do, which is the
	// honest state of the system until those tracks land.
	logger.Info("worker starting",
		slog.String("task_queue", cfg.TaskQueue),
		slog.String("temporal_namespace", cfg.TemporalNamespace),
		slog.String("sandbox_namespace", cfg.SandboxNamespace),
		slog.String("pod", cfg.PodName),
		slog.Int("registered_workflows", 0),
		slog.Int("registered_activities", 0),
	)

	// Run blocks until SIGINT or SIGTERM, then drains: in-flight activities
	// finish, no new tasks are taken. Sandbox pods are deliberately left
	// behind — they are independent objects, and a restarted worker reattaches
	// to the attempt it left running rather than paying for it twice.
	if err := w.Run(worker.InterruptCh()); err != nil {
		return fmt.Errorf("running the worker on task queue %s: %w", cfg.TaskQueue, err)
	}
	logger.Info("worker drained")
	return nil
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
