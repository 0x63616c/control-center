// Command sandbox-worker is the Temporal worker embedded in a per-ticket
// sandbox pod (ADR-0011, #434 step 3). It polls exactly one queue — this
// pod's own SandboxTaskQueue(runID), read back from its environment — under
// a Session (worker.Options.EnableSessionWorker), and hosts RunStage's
// codex invocation as a local subprocess of its own activity, rather than
// having the main worker exec into it remotely.
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
//
// This process registers RunStage and nothing else today. CloneRepo stays on
// cmd/worker: it mints a GitHub App installation token in-process, and #431
// has not yet decided whether the sandbox pod may hold that capability
// itself — see activities.SandboxDeps' own doc comment. (WriteCodexCredential
// used to stay there for the same class of reason, until D3's Secret mount
// made it a no-op nothing called for any more; it and the workticket.go call
// to it are deleted.)
package main

import (
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"go.temporal.io/sdk/client"
	tlog "go.temporal.io/sdk/log"
	"go.temporal.io/sdk/worker"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codex"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/local"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/config"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/prompts"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/telemetry"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/transcripts"
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

// transcriptsSubdir is where this pod's local, pre-relay transcript sink
// writes, under work.SandboxRoot — the emptyDir every stage's other
// scaffolding (prompt, schema, result) already lives under.
//
// This is NOT the transcript relay: nothing here ships these bytes back to
// the real, NFS-backed transcript volume. That is D5 (#434's credential
// transport + transcript relay slice) — a PersistTranscript activity on the
// main worker's queue, and a transcript field on RunStage's own output. Until
// that lands, whatever a sandbox pod's stages write here is local to the pod
// and is lost when DeleteSandbox removes it. Constructing the Sink here is
// only what RunStage's existing signature already requires to run at all —
// see internal/transcripts.Sink's own doc comment: "reused twice... once
// inside the sandbox pod's process, rooted at a plain local path under
// /work" is D5's own description of exactly this construction.
const transcriptsSubdir = work.SandboxRoot + "/.transcripts"

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

		// The two options that make this pod eligible to HOST a session, and
		// bound it to exactly one at a time — D1's "a pod serves one ticket
		// at a time" and B3's "exactly one CreateSession per ticket run" are
		// both properties of THIS worker instance, not of the cluster.
		EnableSessionWorker:               true,
		MaxConcurrentSessionExecutionSize: 1,
	})

	renderer, err := newPromptRenderer()
	if err != nil {
		return err
	}

	acts, err := newActivities(renderer, logger)
	if err != nil {
		return fmt.Errorf("building the sandbox-side activity set: %w", err)
	}

	register(w, acts, logger)

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

// register puts this pod's one activity on its task queue.
//
// Deliberately NOT w.RegisterActivity(acts): that registers every exported
// method Temporal's SDK recognises as an activity signature, which for
// *activities.Activities is every activity this whole service has, sandbox
// or not. Registering the bound method directly registers exactly the one
// name this process is prepared to serve — the same "only what this process
// is prepared to serve" guarantee acceptance criterion 4 checks for on the
// workflow side, applied here to activities too.
func register(w worker.Worker, acts *activities.Activities, logger *slog.Logger) {
	w.RegisterActivity(acts.RunStage)

	logger.Info("registrations",
		slog.Int("workflows", 0),
		slog.Int("activities", 1),
	)
}

// newActivities builds the one activity this process hosts, from concrete,
// local-transport clients.
//
// No HTTP metrics endpoint is built or served here, unlike cmd/worker: an
// ephemeral per-ticket pod is not something Prometheus is configured to
// discover (no ServiceMonitor targets it), so *telemetry.Metrics is still
// constructed — activities.SandboxDeps requires one — but nothing ever
// scrapes its registry. Flagged as a gap, not solved: a later slice may want
// to expose one if that changes.
func newActivities(renderer *prompts.Renderer, logger *slog.Logger) (*activities.Activities, error) {
	if err := os.MkdirAll(transcriptsSubdir, 0o750); err != nil {
		return nil, fmt.Errorf("creating the local transcript directory %s: %w", transcriptsSubdir, err)
	}
	transcriptSink, err := transcripts.New(transcriptsSubdir)
	if err != nil {
		return nil, fmt.Errorf("building the local transcript sink at %s: %w", transcriptsSubdir, err)
	}

	deps := buildSandboxDeps(transcriptSink, renderer, logger)
	return activities.NewSandboxSide(deps)
}

// buildSandboxDeps assembles activities.SandboxDeps from clients newActivities
// already built. Pulled out of newActivities, the same reason cmd/worker's
// buildDeps is pulled out of its own newActivities: it can be exercised
// without touching this pod's real filesystem, and a future field added to
// SandboxDeps gains that coverage automatically rather than depending on
// someone remembering to update a second list.
func buildSandboxDeps(transcriptSink activities.TranscriptSink, renderer *prompts.Renderer, logger *slog.Logger) activities.SandboxDeps {
	return activities.SandboxDeps{
		// local, not internal/clients/k8s: this process already runs inside
		// the sandbox, so a stage's codex invocation is a subprocess of this
		// very activity rather than something reached over the Kubernetes
		// API.
		Stages:      codex.NewRunner(local.NewExecer(), local.NewFileTransfer(), logger),
		Transcripts: transcriptSink,
		Prompts:     prompts.NewActivityRenderer(renderer),
		Metrics:     telemetry.NewMetrics(prometheus.NewRegistry()),
		Log:         logger,
		Clock:       clock.System{},
	}
}

// newLogger is this process's one logger: JSON on stdout, matching
// cmd/worker's own so the cluster's Loki pipeline picks up both the same way.
func newLogger(level slog.Level) *slog.Logger {
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
}
