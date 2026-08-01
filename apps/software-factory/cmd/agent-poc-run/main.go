// Command agent-poc-run starts one direct-Codex POC workflow and prints safe evidence.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agentpoc"
	temporalapi "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/temporal"
	tlog "go.temporal.io/sdk/log"
)

func main() {
	if err := run(); err != nil {
		slog.New(slog.NewJSONHandler(os.Stderr, nil)).Error("the agent POC run failed", "error", err)
		os.Exit(1)
	}
}

func run() error {
	temporalAddress := flag.String("temporal-address", "temporal:7233", "Temporal frontend host:port")
	namespace := flag.String("namespace", "default", "Temporal namespace")
	workflowID := flag.String("workflow-id", "", "unique workflow id")
	model := flag.String("model", "", "Codex model name")
	prompt := flag.String("prompt", "Use the prototype tool and tell me the exact fact it returns.", "agent prompt")
	maxTurns := flag.Int("max-turns", 3, "maximum model turns")
	flag.Parse()
	if *workflowID == "" || *model == "" || *prompt == "" {
		return fmt.Errorf("workflow-id, model, and prompt are required")
	}

	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	temporal, err := temporalapi.Dial(temporalapi.Options{
		HostPort:  *temporalAddress,
		Namespace: *namespace,
		Logger:    tlog.NewStructuredLogger(logger),
	}, nil, nil)
	if err != nil {
		return fmt.Errorf("dialling Temporal: %w", err)
	}
	defer temporal.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	run, err := temporal.ExecuteWorkflow(ctx, temporalapi.StartWorkflowOptions{
		ID:        *workflowID,
		TaskQueue: agentpoc.TaskQueue,
	}, agentpoc.WorkflowName, agentpoc.Input{
		Prompt:         *prompt,
		Model:          *model,
		MaxTurns:       *maxTurns,
		PromptCacheKey: *workflowID,
	})
	if err != nil {
		return fmt.Errorf("starting workflow: %w", err)
	}
	var result agentpoc.Result
	if err := run.Get(ctx, &result); err != nil {
		return fmt.Errorf("waiting for workflow %s: %w", run.GetID(), err)
	}
	evidence := struct {
		WorkflowID string          `json:"workflow_id"`
		RunID      string          `json:"run_id"`
		Result     agentpoc.Result `json:"result"`
	}{WorkflowID: run.GetID(), RunID: run.GetRunID(), Result: result}
	if err := json.NewEncoder(os.Stdout).Encode(evidence); err != nil {
		return fmt.Errorf("printing workflow evidence: %w", err)
	}
	return nil
}
