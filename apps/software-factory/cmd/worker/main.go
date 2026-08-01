// Command worker runs the software factory: a Temporal worker that reads
// ready Tickets from the factory's own Postgres and takes them from idea to
// open pull request.
//
// This file is the composition root, and it is the only place in the service
// where a concrete client meets an interface that consumes it. Construction is
// manual and explicit — no container, no reflection, no init() — so what the
// process is made of is what is written here, top to bottom, and a test
// elsewhere can hand any of it a fake.
package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"go.temporal.io/sdk/activity"
	tlog "go.temporal.io/sdk/log"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	agentactivities "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agenttools"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/blobs"
	checkpointclient "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/checkpoint"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codexresponses"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/github"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/k8s"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/runs"
	temporalapi "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/temporal"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/config"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/prompts"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/telemetry"
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
// It is deliberately far shorter than a stage. Stages run on the sandbox
// worker that hosts their Session, not on this main worker, so draining this
// process does not cancel them. This window is for the short control activities
// here — a GitHub comment, a transcript write, a credential rotation — finishing
// instead of being torn in half.
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

	// Pinged before anything else starts, matching cmd/api: SoftwareStyle
	// tenet 7 (fail fast, fail helpful). An unreachable database would
	// otherwise start a dispatcher that looks healthy and fails its
	// RecordDispatcherState activity every tick forever, silently, instead of
	// crash-looping loudly at boot with the reason in its logs.
	//
	// One pool, one *store.Store, for both dispatchers: the legacy one's
	// per-tick dispatcher_state row (#551) and ADR-0012's Ticket-driven
	// pipeline (Tickets, Runs, Steps, Attempts, transcripts) below both read
	// and write the same factory Postgres. cmd/api already applies this
	// service's migrations at its own boot and is deployed ahead of this
	// worker (#554), so the worker only needs to dial and ping — it does not
	// re-run ApplyMigrations.
	dbPool, err := pgxpool.New(context.Background(), cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("constructing the factory database pool: %w", err)
	}
	defer dbPool.Close()
	pingCtx, cancelPing := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelPing()
	if err := dbPool.Ping(pingCtx); err != nil {
		return fmt.Errorf("pinging the factory database before worker startup: %w", err)
	}
	factoryStore := store.New(dbPool)

	// The one metrics registry in this process. Prometheus panics on a
	// duplicate registration, deliberately, so a second registry or a second
	// construction of the metrics that record into it is a crash in
	// production; that is why both live here and are passed down.
	registry, metrics := newObservability()
	blobStore, err := blobs.NewHTTPStore(cfg.BlobsURL, nil)
	if err != nil {
		return fmt.Errorf("opening HTTP blob store: %w", err)
	}

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

	temporal, err := temporalapi.Dial(temporalapi.Options{
		HostPort:  cfg.TemporalHostPort,
		Namespace: cfg.TemporalNamespace,
		Logger:    tlog.NewStructuredLogger(logger),
	}, blobStore, metrics)
	if err != nil {
		return fmt.Errorf("dialling Temporal at %s in namespace %s: %w", cfg.TemporalHostPort, cfg.TemporalNamespace, err)
	}
	defer temporal.Close()

	w := worker.New(temporal, work.TaskQueue, worker.Options{
		WorkerStopTimeout: workerStopTimeout,
	})

	renderer, err := newPromptRenderer()
	if err != nil {
		return fmt.Errorf("building the prompt renderer: %w", err)
	}

	clk := clock.System{}
	tokenSource, err := newCodexAuthSource(cfg, clk, logger)
	if err != nil {
		return fmt.Errorf("building the codex credential source: %w", err)
	}
	acts, runWorkerControl, err := newActivities(
		cfg, temporal, renderer, metrics, logger, factoryStore, factoryStore,
	)
	if err != nil {
		return fmt.Errorf("building the activity set: %w", err)
	}

	// ADR-0012's second, Ticket-driven activity sets, over the same
	// factoryStore: they read and write Tickets, Runs, Steps, Attempts and
	// transcripts, never a GitHub issue or comment.
	ticketActs, err := activities.NewTicketActivities(factoryStore)
	if err != nil {
		return fmt.Errorf("building the ticket activity set: %w", err)
	}
	recordingActs, err := activities.NewRecordingActivities(factoryStore)
	if err != nil {
		return fmt.Errorf("building the recording activity set: %w", err)
	}
	targetRecordingActs, err := activities.NewTargetRecordingActivities(factoryStore)
	if err != nil {
		return fmt.Errorf("building the target recording activity set: %w", err)
	}
	targetRecoveryActs, err := activities.NewTargetRecoveryActivities(factoryStore)
	if err != nil {
		return fmt.Errorf("building the target recovery activity set: %w", err)
	}
	transcriptActs, err := activities.NewTranscriptRecordingActivities(factoryStore)
	if err != nil {
		return fmt.Errorf("building the transcript recording activity set: %w", err)
	}
	agentTranscriptActs, err := activities.NewAgentTranscriptRecordingActivities(factoryStore, blobStore)
	if err != nil {
		return fmt.Errorf("building the agent transcript activity set: %w", err)
	}
	targetEvidenceActs, err := activities.NewTargetAgentEvidenceActivities(factoryStore, blobStore)
	if err != nil {
		return fmt.Errorf("building the target agent evidence activity set: %w", err)
	}
	toolsets, err := agenttools.NewToolsets(work.RepoDir, "model/catalog", blobStore)
	if err != nil {
		return fmt.Errorf("building the model-visible agent toolsets: %w", err)
	}
	credentialSource, err := codexresponses.NewManagedCredentialSource(tokenSource)
	if err != nil {
		return fmt.Errorf("adapting the durable codex credential source: %w", err)
	}
	turner, err := codexresponses.New(
		&http.Client{Timeout: 110 * time.Second}, cfg.CodexResponsesEndpoint, credentialSource, logger,
	)
	if err != nil {
		return fmt.Errorf("building the direct Codex Responses client: %w", err)
	}
	modelActs, err := agentactivities.NewObservedActivities(turner, blobStore, clk, metrics, logger, toolsets...)
	if err != nil {
		return fmt.Errorf("building the agent model activity set: %w", err)
	}
	promptActs, err := agentactivities.NewPromptActivities(prompts.NewActivityRenderer(renderer), blobStore)
	if err != nil {
		return fmt.Errorf("building the agent prompt activity set: %w", err)
	}

	// Registration site. Every workflow and activity set this worker runs is
	// registered here, on this worker, and nowhere else — one queue, one
	// worker, one list.
	register(
		w, acts, runWorkerControl, ticketActs, recordingActs, targetRecordingActs, targetRecoveryActs, transcriptActs,
		agentTranscriptActs, targetEvidenceActs, modelActs, promptActs, logger,
	)

	// Idempotent: a worker replica that loses the race to start this simply
	// attaches to the execution the winner started, which is why it happens on
	// every boot rather than once, ever, by hand.
	if err := ensureFactoryDispatcher(context.Background(), temporal, logger); err != nil {
		return fmt.Errorf("ensuring the factory ticket dispatcher is running: %w", err)
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
		// The config the dispatcher would START on, which is not the same as
		// the config a running one is using — hence the name. The dispatcher
		// is a long-running workflow that continues as new carrying its config
		// in workflow state, so after the first start this is logged and then
		// ignored; a live change is the UpdateConfig signal the API sends.
		slog.Group("dispatcher_starting_config",
			slog.Bool("paused", work.DefaultFactoryConfig().Paused),
			slog.Int("max_in_flight", work.DefaultFactoryConfig().MaxInFlight),
			slog.String("default_model", work.DefaultFactoryConfig().DefaultModel.Name),
		),
	)

	// Run blocks until SIGINT or SIGTERM, then drains: no new tasks are taken,
	// and in-flight activities get workerStopTimeout to finish before their
	// contexts are cancelled. Sandbox pods are deliberately left behind: their
	// Session workers own stage activities, so this main-worker drain neither
	// cancels nor resumes them.
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
func register(
	w worker.Worker,
	acts *activities.Activities,
	runWorkerControl *activities.RunWorkerControlActivities,
	ticketActs *activities.TicketActivities,
	recordingActs *activities.RecordingActivities,
	targetRecordingActs *activities.TargetRecordingActivities,
	targetRecoveryActs *activities.TargetRecoveryActivities,
	transcriptActs *activities.TranscriptRecordingActivities,
	agentTranscriptActs *activities.AgentTranscriptRecordingActivities,
	targetEvidenceActs *activities.TargetAgentEvidenceActivities,
	modelActs *agentactivities.Activities,
	promptActs *agentactivities.PromptActivities,
	logger *slog.Logger,
) {
	w.RegisterWorkflow(workflows.FactoryWorkTicket)
	w.RegisterWorkflow(workflows.FactoryDispatcher)
	w.RegisterWorkflow(workflows.WorkOnTicket)
	w.RegisterWorkflowWithOptions(workflows.AgentWorkflow, workflow.RegisterOptions{Name: agent.WorkflowName})
	for _, activityMethod := range []any{
		acts.CreateSandbox,
		acts.WaitSandboxReady,
		acts.CloneRepo,
		acts.PushRepo,
		acts.DeleteSandbox,
		acts.FindPullRequest,
		acts.OpenOrUpdatePullRequest,
		acts.ObserveCI,
		acts.ConvertPullRequestToDraft,
		acts.MarkPullRequestReadyForReview,
		acts.EnablePullRequestAutoMerge,
		acts.DescribeRun,
		acts.SweepOrphanSandboxes,
	} {
		w.RegisterActivity(activityMethod)
	}
	w.RegisterActivity(runWorkerControl)
	w.RegisterActivity(ticketActs)
	w.RegisterActivity(recordingActs)
	w.RegisterActivity(targetRecordingActs)
	w.RegisterActivity(targetRecoveryActs)
	w.RegisterActivity(transcriptActs)
	w.RegisterActivity(targetEvidenceActs)
	w.RegisterActivityWithOptions(promptActs.Prepare, activity.RegisterOptions{Name: agent.PrepareActivityName})
	w.RegisterActivityWithOptions(modelActs.ModelTurn, activity.RegisterOptions{Name: agent.ModelTurnActivityName})
	w.RegisterActivityWithOptions(modelActs.RecordLifecycle, activity.RegisterOptions{Name: agent.LifecycleActivityName})
	w.RegisterActivityWithOptions(promptActs.Finalize, activity.RegisterOptions{Name: agent.FinalizeActivityName})
	w.RegisterActivityWithOptions(
		agentTranscriptActs.PersistAgentTranscript,
		activity.RegisterOptions{Name: agent.PersistTranscriptActivityName},
	)

	logger.Info("registrations",
		slog.Int("workflows", 4),
		slog.Int("stages_per_ticket", len(work.Pipeline())),
		slog.Int("max_in_flight", work.DefaultFactoryConfig().MaxInFlight),
	)
}

// ensureFactoryDispatcher starts the new dispatcher, or attaches to it if a
// worker before this one already did — the same idempotent start-on-boot
// shape as ensureDispatcher, on the disjoint FactoryDispatcherWorkflowID
// singleton.
func ensureFactoryDispatcher(ctx context.Context, c dispatcherStarter, logger *slog.Logger) error {
	run, err := c.ExecuteWorkflow(ctx, temporalapi.StartWorkflowOptions{
		ID:        work.FactoryDispatcherWorkflowID,
		TaskQueue: work.TaskQueue,
	}, workflows.FactoryDispatcher, workflows.FactoryDispatcherInput{
		Config: work.DefaultFactoryConfig(),
		Tuning: work.DefaultDispatcherTuning(),
		Run:    work.DefaultRunPolicy(),
	})
	if err != nil {
		return fmt.Errorf("starting the factory ticket dispatcher workflow %s: %w", work.FactoryDispatcherWorkflowID, err)
	}

	logger.Info("factory ticket dispatcher workflow ensured",
		slog.String("workflow_id", work.FactoryDispatcherWorkflowID),
		slog.String("run_id", run.GetRunID()))
	return nil
}

// newActivities builds the one activity set from concrete clients: GitHub,
// the sandbox pods, the run lookup and the sandbox sweep.
//
// It is the composition root's other half of "a concrete client meets an
// interface that consumes it" — main.go's own doc comment — kept out of run()
// only because the list of clients is long enough to want its own name.
//
// One *k8s.Sandboxes instance is shared across three roles (Pods, Repo and
// Sweeper):
// it is "the only place this service speaks to the Kubernetes API" per its
// own doc comment, and constructing a second would be a second client holding
// a second watch on the same pods.
func newActivities(
	cfg config.Worker, temporal temporalapi.Client, renderer *prompts.Renderer, metrics *telemetry.Metrics, logger *slog.Logger,
	dispatcherState activities.DispatcherStateWriter,
	checkpointBinder interface {
		activities.CheckpointCapabilityBinder
		activities.RepositoryCapabilityBinder
	},
) (*activities.Activities, *activities.RunWorkerControlActivities, error) {
	clk := clock.System{}

	ghCfg, err := config.LoadGitHub()
	if err != nil {
		return nil, nil, fmt.Errorf("reading the GitHub App's configuration: %w", err)
	}
	ghClient, err := github.New(ghCfg, clk, logger)
	if err != nil {
		return nil, nil, fmt.Errorf("building the GitHub client: %w", err)
	}

	sandboxes, err := k8s.NewInCluster(cfg.SandboxNamespace, logger, clk, k8s.WithImagePullSecret(cfg.SandboxImagePullSecretName))
	if err != nil {
		return nil, nil, fmt.Errorf("building the Kubernetes sandbox client: %w", err)
	}

	legacy, err := activities.New(buildDeps(
		cfg, ghCfg, ghClient, sandboxes, temporal, dispatcherState, clk, logger,
	))
	if err != nil {
		return nil, nil, fmt.Errorf("building legacy activities: %w", err)
	}
	runWorkers, err := k8s.NewRunWorkersInCluster(cfg.SandboxNamespace, logger, cfg.SandboxImagePullSecretName)
	if err != nil {
		return nil, nil, fmt.Errorf("building the Kubernetes Run Worker client: %w", err)
	}
	capabilities, err := checkpointclient.NewCapabilityMinter(rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("building the checkpoint capability minter: %w", err)
	}
	control, err := activities.NewRunWorkerControlActivities(activities.RunWorkerControlDeps{
		Workers: runWorkers, GitHub: ghClient, Capabilities: capabilities,
		Binder: checkpointBinder, RepositoryBinder: checkpointBinder,
		Template: activities.RunWorkerTemplate{
			Image: cfg.RunWorkerImage, CPURequest: cfg.SandboxCPURequest, MemoryLimit: cfg.SandboxMemoryLimit,
			DeadlineSeconds: work.SandboxDeadlineSeconds,
			Env: map[string]string{
				work.GhConfigDirEnv:               work.GhConfigDir,
				work.RunWorkerTemporalHostPortEnv: cfg.TemporalHostPort, work.RunWorkerTemporalNamespaceEnv: cfg.TemporalNamespace,
				work.RunWorkerBlobsURLEnv: cfg.BlobsURL, work.RunWorkerCheckpointAPIURLEnv: cfg.CheckpointAPIURL,
				work.RunWorkerGitHubRepositoryEnv: ghCfg.Owner + "/" + ghCfg.Repo,
				work.RunWorkerMetricsAddrEnv:      ":9090",
			},
		},
	})
	if err != nil {
		return nil, nil, fmt.Errorf("building the Run Worker control activities: %w", err)
	}
	return legacy, control, nil
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
// this function did not exist to catch it first.
//
// One *k8s.Sandboxes is threaded through Pods, Repo and Sweeper deliberately:
// see the doc on newActivities for why a second instance would be wrong.
func buildDeps(
	cfg config.Worker,
	ghCfg config.GitHub,
	ghClient activities.GitHub,
	sandboxes *k8s.Sandboxes,
	temporal temporalapi.Client,
	dispatcherState activities.DispatcherStateWriter,
	clk clock.Clock,
	logger *slog.Logger,
) activities.Deps {
	sandboxTemplate := work.SandboxTemplate{
		Image:           cfg.SandboxImage,
		CPURequest:      cfg.SandboxCPURequest,
		MemoryLimit:     cfg.SandboxMemoryLimit,
		DeadlineSeconds: work.SandboxDeadlineSeconds,
		Env: map[string]string{
			work.GhConfigDirEnv: work.GhConfigDir,

			// The sandbox pod's own embedded Temporal worker (#434 step 3,
			// cmd/sandbox-worker) dials the exact same frontend and namespace
			// this process just dialled above — one Temporal cluster, two
			// kinds of worker — so these are copied from cfg rather than a
			// second pair of environment variables this process would have
			// to be given separately for no reason.
			work.SandboxTemporalHostPortEnv:  cfg.TemporalHostPort,
			work.SandboxTemporalNamespaceEnv: cfg.TemporalNamespace,
			work.SandboxBlobsURLEnv:          cfg.BlobsURL,
		},
	}

	return activities.Deps{
		GitHub:  ghClient,
		Pods:    sandboxes,
		Repo:    sandboxes,
		Runs:    runs.New(temporal),
		Sweeper: sandboxes,

		// DispatcherState is the store row the dispatcher writes its post-tick
		// projection to (#551) — the console will eventually read this instead
		// of querying Temporal for status.
		DispatcherState: dispatcherState,

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
