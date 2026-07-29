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

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codex"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/github"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/k8s"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/runs"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/config"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/prompts"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/status"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/telemetry"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/transcripts"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
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
	registry, metrics := newObservability()

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

	w := worker.New(temporal, work.TaskQueue, worker.Options{
		WorkerStopTimeout: workerStopTimeout,
	})

	renderer, err := newPromptRenderer()
	if err != nil {
		return err
	}

	acts, err := newActivities(cfg, temporal, renderer, metrics, logger)
	if err != nil {
		return fmt.Errorf("building the activity set: %w", err)
	}

	// Registration site. The dispatcher and WorkTicket workflows and the
	// activities that carry out a stage are registered here, on this worker,
	// and nowhere else — one queue, one worker, one list.
	register(w, acts, dispatcher, logger)

	// Idempotent: a worker replica that loses the race to start this simply
	// attaches to the execution the winner started. See ensureDispatcher's
	// doc comment for why this happens on every boot rather than once, ever,
	// by hand.
	if err := ensureDispatcher(context.Background(), temporal, dispatcher, logger); err != nil {
		return fmt.Errorf("ensuring the dispatcher is running: %w", err)
	}

	logger.Info("worker starting",
		// Two different concepts that happen to share the string
		// "software-factory": the queue work is scheduled on, and the Temporal
		// namespace it lives in. They are logged as separate fields, and a
		// runbook command line that transposes --task-queue and --namespace
		// would be invisible on the wire — worth reading twice.
		slog.String("task_queue", work.TaskQueue),
		slog.String("temporal_namespace", cfg.TemporalNamespace),
		slog.String("sandbox_namespace", cfg.SandboxNamespace),
		slog.String("pod", cfg.PodName),
		// The config a dispatcher would START on, which is not the same as the
		// config a running one is using — hence the name. ADR-0011's dispatcher
		// is a long-running workflow that continues as new, carrying its config
		// in workflow state, so after the first start DISPATCHER_CONFIG is
		// read, validated, logged here, and then ignored.
		//
		// Logging it as "the dispatcher's config" is how somebody lowers
		// maxInFlight to stop eating the rate-limit window, rolls the
		// Deployment, reads this line back, and believes it — while the live
		// dispatcher runs on the value it started with days ago. Once C2 lands,
		// a deploy that means to change a running dispatcher pushes an
		// UpdateConfig signal; the honest answer for a live system is the
		// GetStatus query, not this.
		slog.Group("dispatcher_starting_config",
			slog.Bool("paused", dispatcher.Paused),
			slog.Int("max_in_flight", dispatcher.MaxInFlight),
			slog.Int64("breaker_cooldown_seconds", dispatcher.BreakerCooldownSeconds),
			slog.String("default_model", dispatcher.DefaultModel.Name),
		),
	)

	// Run blocks until SIGINT or SIGTERM, then drains: no new tasks are taken,
	// and in-flight activities get workerStopTimeout to finish before their
	// contexts are cancelled. A stage will not finish in that window and is not
	// meant to — see workerStopTimeout. Sandbox pods are deliberately left
	// behind — they are independent objects, and a restarted worker reattaches
	// to the attempt it left running rather than paying for it twice.
	if err := w.Run(worker.InterruptCh()); err != nil {
		return fmt.Errorf("running the worker on task queue %s: %w", work.TaskQueue, err)
	}
	logger.Info("worker drained")
	return nil
}

// newObservability builds the process's one metrics registry and the one set of
// stage metrics recording into it.
//
// Both are singletons and both are here for the same reason: Prometheus panics
// on a duplicate registration, deliberately. A second registry or a second
// construction of the metrics is a crash in production — and the quieter half
// of that is worse. A track that built its own Metrics against its own registry
// would not panic at all; its counters would increment into a registry nothing
// serves, and /metrics would stay empty while every call site looked correct.
//
// The stage metrics are built even though nothing records into them yet,
// because "construct it where it can only happen once" is the property, and a
// gap here is what the next track fills with its own copy.
func newObservability() (*prometheus.Registry, *telemetry.Metrics) {
	registry := prometheus.NewRegistry()
	registry.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)
	return registry, telemetry.NewMetrics(registry)
}

// register puts this worker's workflows and activities on its task queue.
//
// One function, one call site: a registration list that grew in two places
// would be a queue serving a set of workflows nobody can enumerate. The
// WorkTicket and Dispatcher workflows, and every activity method, land here
// and nowhere else.
//
// acts arrives fully built rather than being assembled here: newActivities is
// where every concrete client meets the interface it satisfies, and this
// function's only job is telling the worker about the result — mixing the two
// would make "what got registered" and "what got constructed" one lookup
// instead of two.
func register(w worker.Worker, acts *activities.Activities, dispatcher work.Config, logger *slog.Logger) {
	w.RegisterWorkflow(workflows.WorkTicket)
	w.RegisterWorkflow(workflows.Dispatcher)
	w.RegisterActivity(acts)

	logger.Info("registrations",
		slog.Int("workflows", 2),
		slog.Int("stages_per_ticket", len(work.Pipeline())),
		slog.Int("max_in_flight", dispatcher.MaxInFlight),
	)
}

// newActivities builds the one activity set from concrete clients: GitHub,
// the sandbox pods, the codex stage runner, transcripts, the prompt and
// status renderers, the run lookup and the sandbox sweep.
//
// It is the composition root's other half of "a concrete client meets an
// interface that consumes it" — main.go's own doc comment — kept out of run()
// only because the list of clients is long enough to want its own name.
//
// One *k8s.Sandboxes instance is shared across three roles (Pods, Sweeper,
// and — through codex.NewRunner — the stage runner's exec and file transfer):
// it is "the only place this service speaks to the Kubernetes API" per its
// own doc comment, and constructing a second would be a second client holding
// a second watch on the same pods.
func newActivities(
	cfg config.Worker, temporal client.Client, renderer *prompts.Renderer, metrics *telemetry.Metrics, logger *slog.Logger,
) (*activities.Activities, error) {
	clk := clock.System{}

	ghCfg, err := config.LoadGitHub()
	if err != nil {
		return nil, fmt.Errorf("reading the GitHub App's configuration: %w", err)
	}
	ghClient, err := github.New(ghCfg, clk, logger)
	if err != nil {
		return nil, fmt.Errorf("building the GitHub client: %w", err)
	}

	sandboxes, err := k8s.NewInCluster(cfg.SandboxNamespace, logger, clk, k8s.WithImagePullSecret(cfg.SandboxImagePullSecretName))
	if err != nil {
		return nil, fmt.Errorf("building the Kubernetes sandbox client: %w", err)
	}

	transcriptSink, err := transcripts.New(cfg.TranscriptsRoot)
	if err != nil {
		return nil, fmt.Errorf("building the transcript sink at %s (TRANSCRIPTS_ROOT): %w", cfg.TranscriptsRoot, err)
	}

	tokenSource, err := newCodexAuthSource(cfg, clk, logger)
	if err != nil {
		return nil, fmt.Errorf("building the codex credential source: %w", err)
	}

	return activities.New(buildDeps(cfg, ghCfg, ghClient, sandboxes, transcriptSink, renderer, metrics, temporal, tokenSource, clk, logger))
}

// buildDeps assembles activities.Deps from clients newActivities already
// built. It is pulled out of newActivities, rather than inlined at its one
// call site, so it can be exercised without dialling Temporal, the in-cluster
// Kubernetes API or a real GitHub App key — every one of which newActivities
// itself needs just to get this far. TestBuildDepsSatisfiesActivitiesNew is
// what that buys: it hands buildDeps a stand-in for every client and asserts
// the result is a Deps activities.New accepts, which is the whole of what
// "this seam is wired into the composition root" means. #395 shipped a new
// Deps field, Repo, that this file did not yet populate; activities.New
// caught it loudly in a pod's crash loop rather than here, in a test, because
// this function did not exist to catch it first. #398 adds two more,
// TokenSource and CredentialWriter, through the same seam.
//
// tokenSource is a parameter rather than built here for the same reason
// sandboxes is: newCodexAuthSource dials the in-cluster Kubernetes API to
// build a SecretStore, which TestBuildDepsSatisfiesActivitiesNew cannot do
// outside a pod. Constructing it stays in newActivities, alongside sandboxes.
//
// One *k8s.Sandboxes is threaded through Pods, Repo, Sweeper, CredentialWriter
// and — via codex.NewRunner — the stage runner's exec and file transfer,
// deliberately: see the doc on newActivities for why a second instance would
// be wrong.
func buildDeps(
	cfg config.Worker,
	ghCfg config.GitHub,
	ghClient activities.GitHub,
	sandboxes *k8s.Sandboxes,
	transcriptSink activities.TranscriptSink,
	renderer *prompts.Renderer,
	metrics *telemetry.Metrics,
	temporal client.Client,
	tokenSource activities.TokenSource,
	clk clock.Clock,
	logger *slog.Logger,
) activities.Deps {
	// CODEX_HOME is part of the contract with the sandbox image (like
	// SF_BRANCH), set on every sandbox's template so codex exec always knows
	// where to look. It is never a secret: the credential itself is written
	// as a file by WriteCodexCredential, never carried in the environment.
	sandboxTemplate := work.SandboxTemplate{
		Image:           cfg.SandboxImage,
		CPULimit:        cfg.SandboxCPULimit,
		MemoryLimit:     cfg.SandboxMemoryLimit,
		DeadlineSeconds: work.SandboxDeadlineSeconds,
		Env:             map[string]string{work.CodexHomeEnv: work.CodexHomeDir},
	}

	return activities.Deps{
		GitHub:      ghClient,
		Pods:        sandboxes,
		Repo:        sandboxes,
		Stages:      codex.NewRunner(sandboxes, sandboxes, clk, logger),
		Transcripts: transcriptSink,
		Prompts:     prompts.NewActivityRenderer(renderer),
		Status:      status.NewRenderer(cfg.TemporalUIBaseURL, cfg.TemporalNamespace),
		Runs:        runs.New(temporal),
		Sweeper:     sandboxes,
		Metrics:     metrics,

		// TokenSource fetches and refreshes the codex credential; sandboxes —
		// the same *k8s.Sandboxes bound to Pods, Repo and Sweeper above —
		// writes what it yields into a sandbox's filesystem. See #398.
		TokenSource:      tokenSource,
		CredentialWriter: sandboxes,

		Log:     logger,
		Clock:   clk,
		Sandbox: sandboxTemplate,
		RepoURL: cloneURL(ghCfg),
	}
}

// cloneURL is the HTTPS clone URL for the one repository this service works
// tickets against, built from the same GITHUB_OWNER/GITHUB_REPO config.LoadGitHub
// already reads and every worker already has set — CloneRepo's credential and
// this URL both describe the App's own installation, so there is no new
// required environment variable here, only a second use of two that already
// are.
func cloneURL(cfg config.GitHub) string {
	return fmt.Sprintf("https://github.com/%s/%s.git", cfg.Owner, cfg.Repo)
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
