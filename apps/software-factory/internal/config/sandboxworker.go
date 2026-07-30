package config

import (
	"fmt"
	"log/slog"
	"os"
	"strings"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// SandboxWorker is everything cmd/sandbox-worker needs to start: where
// Temporal is, and which per-ticket queue to poll.
//
// It is deliberately much smaller than Worker. This process runs inside a
// per-ticket sandbox pod, holds no Kubernetes API access and creates nothing
// — it polls one queue for the run it was created to serve and stops when
// that pod is deleted, so it has no business reading config a control-plane
// process needs (SandboxNamespace, SandboxImage, CodexAuthSecretName, and so
// on all belong to Worker, never to this).
type SandboxWorker struct {
	// TemporalHostPort is the frontend to dial, host:port. Same value the
	// main worker dials — one Temporal cluster, two kinds of worker.
	TemporalHostPort string

	// TemporalNamespace is the namespace this pod's workflow run lives in.
	TemporalNamespace string

	// TaskQueue is this pod's own per-ticket queue: work.SandboxTaskQueue(runID),
	// computed once by CreateSandbox and read back here rather than
	// recomputed, the same "read back what CreateSandbox baked in" pattern
	// CloneRepo already uses for SF_BRANCH (work.SandboxBranchEnv) — so the
	// workflow, the pod's own env and this process can never disagree about
	// which queue it is polling.
	TaskQueue string

	// LogLevel is the level everything in this process logs at.
	LogLevel slog.Level
}

// Environment variables LoadSandboxWorker reads.
const (
	envSandboxWorkerTemporalHostPort  = "TEMPORAL_HOST_PORT"
	envSandboxWorkerTemporalNamespace = "TEMPORAL_NAMESPACE"
	envSandboxWorkerLogLevel          = "LOG_LEVEL"
)

// sandboxWorkerEnvNames are the variables that must be set. LOG_LEVEL is
// absent deliberately, the same reason workerEnvNames omits it: it is the one
// input with a safe default.
func sandboxWorkerEnvNames() []string {
	return []string{
		envSandboxWorkerTemporalHostPort,
		envSandboxWorkerTemporalNamespace,
		work.SandboxTaskQueueEnv,
	}
}

// Validate reports whether this config can start a sandbox worker.
func (w SandboxWorker) Validate() error {
	required := map[string]string{
		envSandboxWorkerTemporalHostPort:  w.TemporalHostPort,
		envSandboxWorkerTemporalNamespace: w.TemporalNamespace,
		work.SandboxTaskQueueEnv:          w.TaskQueue,
	}
	for _, name := range sandboxWorkerEnvNames() {
		if strings.TrimSpace(required[name]) == "" {
			return fmt.Errorf("%s is required", name)
		}
	}
	return nil
}

// LoadSandboxWorker reads the sandbox worker's configuration from its
// environment.
//
// Everything except the log level is required, and nothing is defaulted: a
// sandbox pod that started polling the wrong queue, or none at all, looks
// exactly like a healthy pod doing nothing — see work.TaskQueue's own doc
// comment on why a queue name is never allowed to silently disagree between
// who names it and who polls it.
func LoadSandboxWorker() (SandboxWorker, error) {
	cfg := SandboxWorker{
		TemporalHostPort:  os.Getenv(envSandboxWorkerTemporalHostPort),
		TemporalNamespace: os.Getenv(envSandboxWorkerTemporalNamespace),
		TaskQueue:         os.Getenv(work.SandboxTaskQueueEnv),
	}
	if err := cfg.Validate(); err != nil {
		return SandboxWorker{}, describeSandboxWorkerRequirement(err)
	}

	level, err := logLevel()
	if err != nil {
		return SandboxWorker{}, err
	}
	cfg.LogLevel = level
	return cfg, nil
}

// describeSandboxWorkerRequirement adds to a missing-variable error what the
// variable is for, the same reason describeWorkerRequirement does for Worker.
func describeSandboxWorkerRequirement(err error) error {
	purposes := map[string]string{
		envSandboxWorkerTemporalHostPort:  "the Temporal frontend to dial, host:port",
		envSandboxWorkerTemporalNamespace: "the Temporal namespace this pod's workflow run lives in",
		work.SandboxTaskQueueEnv:          "this pod's own per-ticket task queue, computed by CreateSandbox and read back here",
	}
	for name, purpose := range purposes {
		if strings.Contains(err.Error(), name) {
			return fmt.Errorf("%w: %s", err, purpose)
		}
	}
	return err
}
