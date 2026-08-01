package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	agentactivities "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agenttools"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/blobs"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codexresponses"
	temporalapi "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/temporal"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/config"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
)

var (
	liveAgentEnabled             = flag.Bool("live-agent", false, "run the live AgentWorkflow acceptance test")
	liveAgentTemporalHostPort    = flag.String("live-agent-temporal-host-port", "", "Temporal frontend host:port")
	liveAgentTemporalNamespace   = flag.String("live-agent-temporal-namespace", "", "Temporal namespace")
	liveAgentMainTaskQueue       = flag.String("live-agent-task-queue", "", "main AgentWorkflow task queue")
	liveAgentCredentialNamespace = flag.String("live-agent-credential-namespace", "", "credential Secret namespace")
	liveAgentCredentialSecret    = flag.String("live-agent-credential-secret", "", "credential Secret name")
	liveAgentPodName             = flag.String("live-agent-pod-name", "", "credential lease holder pod name")
	liveAgentResponsesEndpoint   = flag.String("live-agent-responses-endpoint", "", "direct Responses endpoint")
	liveAgentModel               = flag.String("live-agent-model", "", "subscription-visible model")
	liveAgentWorkflowID          = flag.String("live-agent-workflow-id", "", "acceptance workflow ID")
	liveAgentRunID               = flag.String("live-agent-run-id", "", "logical run ID")
	liveAgentStateRoot           = flag.String("live-agent-state-root", "", "persistent acceptance state root")
	liveAgentRepositoryRoot      = flag.String("live-agent-repository-root", "", "acceptance repository root")
)

// TestLiveAgentWorkflowWorker is the opt-in live acceptance worker used by the
// software-factory runbook. It intentionally composes production primitives
// rather than maintaining a second POC runtime. Normal test runs skip it.
func TestLiveAgentWorkflowWorker(t *testing.T) {
	requireLiveAgentTest(t)

	cfg := liveAgentConfigFromFlags(t)
	store := liveAgentFileStore(t, cfg.stateRoot)
	prepareLiveAgentRepository(t, cfg.repositoryRoot)
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	temporalClient, err := temporalapi.Dial(temporalapi.Options{
		HostPort:  cfg.temporalHostPort,
		Namespace: cfg.temporalNamespace,
	}, store, nil)
	if err != nil {
		t.Fatalf("dial Temporal: %v", err)
	}
	t.Cleanup(temporalClient.Close)

	authSource, err := newCodexAuthSource(config.Worker{
		SandboxNamespace:    cfg.credentialNamespace,
		CodexAuthSecretName: cfg.credentialSecret,
		PodName:             cfg.podName,
	}, clock.System{}, logger)
	if err != nil {
		t.Fatalf("build managed credential source: %v", err)
	}
	credentialSource, err := codexresponses.NewManagedCredentialSource(authSource)
	if err != nil {
		t.Fatalf("adapt managed credential source: %v", err)
	}
	turner, err := codexresponses.New(
		&http.Client{Timeout: 110 * time.Second}, cfg.responsesEndpoint, credentialSource, logger,
	)
	if err != nil {
		t.Fatalf("build direct Responses client: %v", err)
	}
	toolsets, err := agenttools.NewToolsets(cfg.repositoryRoot, "live-agent-canary", store)
	if err != nil {
		t.Fatalf("build production toolsets: %v", err)
	}
	modelActivities, err := agentactivities.NewActivities(turner, store, clock.System{}, toolsets...)
	if err != nil {
		t.Fatalf("build model activities: %v", err)
	}
	promptActivities, err := agentactivities.NewPromptActivities(liveAgentPromptRenderer{}, store)
	if err != nil {
		t.Fatalf("build prompt activities: %v", err)
	}
	toolActivities, err := agentactivities.NewToolActivities(store, clock.System{}, toolsets...)
	if err != nil {
		t.Fatalf("build tool activities: %v", err)
	}

	mainWorker := worker.New(temporalClient, cfg.mainTaskQueue, worker.Options{WorkerStopTimeout: 30 * time.Second})
	mainWorker.RegisterWorkflowWithOptions(workflows.AgentWorkflow, workflow.RegisterOptions{Name: agent.WorkflowName})
	gatedPrompts := liveGatedPromptActivities{PromptActivities: promptActivities, stateRoot: cfg.stateRoot}
	mainWorker.RegisterActivityWithOptions(gatedPrompts.Prepare, activity.RegisterOptions{Name: agent.PrepareActivityName})
	mainWorker.RegisterActivityWithOptions(modelActivities.ModelTurn, activity.RegisterOptions{Name: agent.ModelTurnActivityName})
	mainWorker.RegisterActivityWithOptions(promptActivities.Finalize, activity.RegisterOptions{Name: agent.FinalizeActivityName})
	mainWorker.RegisterActivityWithOptions(modelActivities.RecordLifecycle, activity.RegisterOptions{Name: agent.LifecycleActivityName})

	sandboxWorker := worker.New(temporalClient, work.SandboxTaskQueue(cfg.runID), worker.Options{
		EnableSessionWorker: true, MaxConcurrentSessionExecutionSize: 1,
		MaxConcurrentActivityExecutionSize: 1, WorkerStopTimeout: 30 * time.Second,
	})
	sandboxWorker.RegisterActivityWithOptions(toolActivities.Tool, activity.RegisterOptions{Name: agent.ToolActivityName})

	if err := mainWorker.Start(); err != nil {
		t.Fatalf("start main worker: %v", err)
	}
	if err := sandboxWorker.Start(); err != nil {
		mainWorker.Stop()
		t.Fatalf("start sandbox worker: %v", err)
	}
	t.Cleanup(func() {
		sandboxWorker.Stop()
		mainWorker.Stop()
	})
	logger.Info("live AgentWorkflow acceptance worker ready",
		"workflow_task_queue", cfg.mainTaskQueue,
		"sandbox_task_queue", work.SandboxTaskQueue(cfg.runID),
	)
	select {}
}

// TestLiveAgentWorkflowStart starts the live acceptance execution and verifies
// both its typed result and the repository mutation made through agent.tool.
func TestLiveAgentWorkflowStart(t *testing.T) {
	requireLiveAgentTest(t)

	cfg := liveAgentConfigFromFlags(t)
	store := liveAgentFileStore(t, cfg.stateRoot)
	temporalClient, err := temporalapi.Dial(temporalapi.Options{
		HostPort:  cfg.temporalHostPort,
		Namespace: cfg.temporalNamespace,
	}, store, nil)
	if err != nil {
		t.Fatalf("dial Temporal: %v", err)
	}
	t.Cleanup(temporalClient.Close)

	run, err := temporalClient.ExecuteWorkflow(t.Context(), temporalapi.StartWorkflowOptions{
		ID: cfg.workflowID, TaskQueue: cfg.mainTaskQueue,
	}, agent.WorkflowName, workflows.AgentWorkflowInput{
		Attempt: activities.StageAttempt{
			Key:     work.StageKey{Ticket: 1, RunID: cfg.runID, Stage: work.StageImplement, Turn: 1},
			Sandbox: work.SandboxID("live-agent-canary"),
			Model:   work.Model{Name: cfg.model, Effort: "medium"},
			Detail: work.TicketDetail{Ticket: work.Ticket{
				Number: 1,
				Title:  "Prove the production AgentWorkflow",
				Body: "Read CANARY.txt, use apply_patch to replace BEFORE with AFTER, verify the file, then report success. " +
					"You must use the supplied tools; do not merely describe the change.",
			}},
		},
		ToolsetID:       agent.ToolsetCodingWriteV1,
		ToolTarget:      agent.ToolTarget{Kind: agent.ToolTargetLegacySandbox},
		ModelTurnPolicy: workflows.LegacyAgentWorkflowModelTurnPolicy(),
		ControlPolicy:   workflows.LegacyAgentWorkflowControlPolicy(),
		Limits: agent.Limits{
			MaxModelTurns: 8, MaxToolCalls: 12, MaxInputTokens: 150_000,
			MaxOutputTokens: 20_000, MaxConversationBytes: 1 << 20, ContinueAsNewAfter: 3,
		},
		CacheKey: cfg.workflowID,
	})
	if err != nil {
		t.Fatalf("start AgentWorkflow: %v", err)
	}
	t.Logf("started workflow_id=%s run_id=%s", run.GetID(), run.GetRunID())

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Minute)
	defer cancel()
	var result workflows.AgentWorkflowResult
	if err := run.Get(ctx, &result); err != nil {
		t.Fatalf("AgentWorkflow result: %v", err)
	}
	if result.ModelTurns < 2 || result.ToolCalls < 2 {
		t.Fatalf("AgentWorkflow used model_turns=%d tool_calls=%d, want a real tool loop", result.ModelTurns, result.ToolCalls)
	}
	contents, err := os.ReadFile(filepath.Join(cfg.repositoryRoot, "CANARY.txt"))
	if err != nil {
		t.Fatalf("read canary result: %v", err)
	}
	if strings.TrimSpace(string(contents)) != "AFTER" {
		t.Fatalf("CANARY.txt = %q, want AFTER", contents)
	}
	if result.Result.Stage() != work.StageImplement || result.Result.Prose() == "" {
		t.Fatalf("typed result = %#v, want a non-empty implement result", result.Result)
	}
	t.Logf("completed model_turns=%d tool_calls=%d transcript=%s", result.ModelTurns, result.ToolCalls, result.TranscriptRef.Key)
}

type liveAgentConfig struct {
	temporalHostPort, temporalNamespace, mainTaskQueue string
	credentialNamespace, credentialSecret, podName     string
	responsesEndpoint, model, workflowID, runID        string
	stateRoot, repositoryRoot                          string
}

func liveAgentConfigFromFlags(t *testing.T) liveAgentConfig {
	t.Helper()
	return liveAgentConfig{
		temporalHostPort:    requireLiveAgentFlag(t, "live-agent-temporal-host-port", *liveAgentTemporalHostPort),
		temporalNamespace:   requireLiveAgentFlag(t, "live-agent-temporal-namespace", *liveAgentTemporalNamespace),
		mainTaskQueue:       requireLiveAgentFlag(t, "live-agent-task-queue", *liveAgentMainTaskQueue),
		credentialNamespace: requireLiveAgentFlag(t, "live-agent-credential-namespace", *liveAgentCredentialNamespace),
		credentialSecret:    requireLiveAgentFlag(t, "live-agent-credential-secret", *liveAgentCredentialSecret),
		podName:             requireLiveAgentFlag(t, "live-agent-pod-name", *liveAgentPodName),
		responsesEndpoint:   requireLiveAgentFlag(t, "live-agent-responses-endpoint", *liveAgentResponsesEndpoint),
		model:               requireLiveAgentFlag(t, "live-agent-model", *liveAgentModel),
		workflowID:          requireLiveAgentFlag(t, "live-agent-workflow-id", *liveAgentWorkflowID),
		runID:               requireLiveAgentFlag(t, "live-agent-run-id", *liveAgentRunID),
		stateRoot:           requireLiveAgentFlag(t, "live-agent-state-root", *liveAgentStateRoot),
		repositoryRoot:      requireLiveAgentFlag(t, "live-agent-repository-root", *liveAgentRepositoryRoot),
	}
}

func requireLiveAgentTest(t *testing.T) {
	t.Helper()
	if !*liveAgentEnabled {
		t.Skip("pass -live-agent to run the live AgentWorkflow acceptance test")
	}
}

func requireLiveAgentFlag(t *testing.T, name, value string) string {
	t.Helper()
	value = strings.TrimSpace(value)
	if value == "" {
		t.Fatalf("-%s is required", name)
	}
	return value
}

func liveAgentFileStore(t *testing.T, stateRoot string) blobs.Store {
	t.Helper()
	root := filepath.Join(stateRoot, "blobs")
	if err := os.MkdirAll(root, 0o750); err != nil {
		t.Fatalf("create blob root: %v", err)
	}
	store, err := blobs.NewFileStore(root)
	if err != nil {
		t.Fatalf("open blob store: %v", err)
	}
	return store
}

func prepareLiveAgentRepository(t *testing.T, root string) {
	t.Helper()
	if err := os.MkdirAll(root, 0o750); err != nil {
		t.Fatalf("create repository root: %v", err)
	}
	canary := filepath.Join(root, "CANARY.txt")
	if _, err := os.Stat(canary); os.IsNotExist(err) {
		if err := os.WriteFile(canary, []byte("BEFORE\n"), 0o640); err != nil {
			t.Fatalf("seed CANARY.txt: %v", err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, ".git")); os.IsNotExist(err) {
		for _, args := range [][]string{{"init"}, {"add", "CANARY.txt"}, {"-c", "user.name=Agent Canary", "-c", "user.email=canary@example.invalid", "commit", "-m", "seed"}} {
			command := exec.CommandContext(t.Context(), "git", args...)
			command.Dir = root
			if output, err := command.CombinedOutput(); err != nil {
				t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, output)
			}
		}
	}
}

type liveAgentPromptRenderer struct{}

type liveGatedPromptActivities struct {
	*agentactivities.PromptActivities
	stateRoot string
}

func (activities liveGatedPromptActivities) Prepare(
	ctx context.Context,
	input agentactivities.PrepareInput,
) (agentactivities.PrepareOutput, error) {
	output, err := activities.PromptActivities.Prepare(ctx, input)
	if err != nil {
		return agentactivities.PrepareOutput{}, err
	}
	ready := filepath.Join(activities.stateRoot, "prepare-ready")
	if err := os.WriteFile(ready, []byte(input.CacheKey), 0o640); err != nil {
		return agentactivities.PrepareOutput{}, fmt.Errorf("write live acceptance gate: %w", err)
	}
	release := filepath.Join(activities.stateRoot, "release-prepare")
	for {
		if _, err := os.Stat(release); err == nil {
			return output, nil
		} else if !os.IsNotExist(err) {
			return agentactivities.PrepareOutput{}, fmt.Errorf("read live acceptance gate: %w", err)
		}
		activity.RecordHeartbeat(ctx, "waiting-for-live-acceptance-release")
		select {
		case <-ctx.Done():
			return agentactivities.PrepareOutput{}, ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

func (liveAgentPromptRenderer) Render(_ work.StageKey, detail work.TicketDetail, _ work.PriorTurns, _ work.AgentPromptContext, _ int) (string, []byte, error) {
	prompt := fmt.Sprintf("%s\n\n%s", detail.Title, detail.Body)
	return prompt, []byte(`{
  "type": "object",
  "properties": {
    "report": {"type": "string"},
    "blocked": {"type": "boolean"},
    "blockedReason": {"type": "string"},
    "title": {"type": "string"},
    "body": {"type": "string"}
  },
  "required": ["report", "blocked", "blockedReason", "title", "body"],
  "additionalProperties": false
}`), nil
}

func (liveAgentPromptRenderer) Decode(stage work.Stage, result []byte) (work.StageOutput, error) {
	if stage != work.StageImplement {
		return work.StageOutput{}, fmt.Errorf("live agent canary only decodes implement output")
	}
	var output struct {
		Report, BlockedReason, Title, Body string
		Blocked                            bool
	}
	if err := json.Unmarshal(result, &output); err != nil {
		return work.StageOutput{}, err
	}
	return work.NewStageOutput(stage, work.ImplementOutput{
		Report: output.Report, Blocked: output.Blocked, BlockedReason: output.BlockedReason,
		Title: output.Title, Body: output.Body,
	}), nil
}
