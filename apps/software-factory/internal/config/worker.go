package config

import (
	"fmt"
	"log/slog"
	"os"
	"strings"
)

// Worker is everything the worker process needs to start: where Temporal is,
// where sandboxes go, what to run in them, and how loudly to say what it is
// doing.
//
// It deliberately holds no tunable behaviour — no concurrency cap, no model
// choice, no dry-run switch. Those are the dispatcher's configuration, which
// travels as a Temporal signal so it can change without a deploy, and a second
// copy of them here would be a second answer to "what is it running under".
type Worker struct {
	// TemporalHostPort is the frontend to dial, host:port.
	TemporalHostPort string

	// TemporalNamespace is the namespace this service's workflows live in.
	TemporalNamespace string

	// TaskQueue is the queue this worker polls. It is configuration rather
	// than a constant so a worker can be pointed at a queue nothing else is
	// serving, which is how a new build is tried without taking the live one.
	TaskQueue string

	// SandboxNamespace is the Kubernetes namespace per-ticket pods are created
	// in. The worker's Role is scoped to it.
	SandboxNamespace string

	// SandboxImage is the per-ticket sandbox image, pinned by digest by the
	// deploy that set it.
	SandboxImage string

	// MetricsAddr is what the metrics and health server listens on.
	MetricsAddr string

	// PodName is this pod's own name, from the downward API. It is not
	// decoration: it identifies the holder of the credential refresh lease, and
	// a lease nobody can attribute cannot be investigated at 3am.
	PodName string

	// LogLevel is the level everything below this process logs at.
	LogLevel slog.Level
}

// Environment variables LoadWorker reads. They are constants because the errors
// quote them, and an error naming an input that does not exist is worse than no
// error at all.
const (
	envTemporalHostPort  = "TEMPORAL_HOST_PORT"
	envTemporalNamespace = "TEMPORAL_NAMESPACE"
	envTaskQueue         = "TEMPORAL_TASK_QUEUE"
	envSandboxNamespace  = "SANDBOX_NAMESPACE"
	envSandboxImage      = "SANDBOX_IMAGE"
	envMetricsAddr       = "METRICS_ADDR"
	envPodName           = "POD_NAME"
	envLogLevel          = "LOG_LEVEL"
)

// workerEnvNames are the variables that must be set. LOG_LEVEL is absent
// deliberately: it is the one input with a safe default.
func workerEnvNames() []string {
	return []string{
		envTemporalHostPort,
		envTemporalNamespace,
		envTaskQueue,
		envSandboxNamespace,
		envSandboxImage,
		envMetricsAddr,
		envPodName,
	}
}

// Validate reports whether this config can start a worker.
//
// It exists beside LoadWorker because a Worker can also be built by hand, and a
// constructor handed a half-filled struct must fail at construction rather than
// at the first poll.
func (w Worker) Validate() error {
	required := map[string]string{
		envTemporalHostPort:  w.TemporalHostPort,
		envTemporalNamespace: w.TemporalNamespace,
		envTaskQueue:         w.TaskQueue,
		envSandboxNamespace:  w.SandboxNamespace,
		envSandboxImage:      w.SandboxImage,
		envMetricsAddr:       w.MetricsAddr,
		envPodName:           w.PodName,
	}
	for _, name := range workerEnvNames() {
		if strings.TrimSpace(required[name]) == "" {
			return fmt.Errorf("%s is required", name)
		}
	}
	return nil
}

// LoadWorker reads the worker's configuration from its environment.
//
// Everything except the log level is required, and nothing is defaulted to a
// plausible-looking value: a worker that starts against the wrong Temporal
// namespace or creates sandboxes in the wrong Kubernetes one looks healthy and
// does nothing, which is the failure that costs a morning.
func LoadWorker() (Worker, error) {
	cfg := Worker{
		TemporalHostPort:  os.Getenv(envTemporalHostPort),
		TemporalNamespace: os.Getenv(envTemporalNamespace),
		TaskQueue:         os.Getenv(envTaskQueue),
		SandboxNamespace:  os.Getenv(envSandboxNamespace),
		SandboxImage:      os.Getenv(envSandboxImage),
		MetricsAddr:       os.Getenv(envMetricsAddr),
		PodName:           os.Getenv(envPodName),
	}
	if err := cfg.Validate(); err != nil {
		return Worker{}, describeWorkerRequirement(err)
	}

	level, err := logLevel()
	if err != nil {
		return Worker{}, err
	}
	cfg.LogLevel = level
	return cfg, nil
}

// describeWorkerRequirement adds to a missing-variable error what the variable
// is for, so the person reading it in a crashloop does not have to find this
// file to fix their Deployment.
func describeWorkerRequirement(err error) error {
	purposes := map[string]string{
		envTemporalHostPort:  "the Temporal frontend to dial, host:port",
		envTemporalNamespace: "the Temporal namespace this service's workflows live in",
		envTaskQueue:         "the task queue this worker polls",
		envSandboxNamespace:  "the Kubernetes namespace per-ticket sandbox pods are created in",
		envSandboxImage:      "the per-ticket sandbox image, pinned by digest",
		envMetricsAddr:       "the address the metrics and health server listens on",
		envPodName:           "this pod's own name, from the downward API; it identifies the credential lease holder",
	}
	for name, purpose := range purposes {
		if strings.Contains(err.Error(), name) {
			return fmt.Errorf("%w: %s", err, purpose)
		}
	}
	return err
}

// logLevel reads the one optional input. Unset is info; unreadable is an error
// rather than a silent fallback, because a worker logging at a level nobody
// asked for is discovered halfway through debugging something else.
func logLevel() (slog.Level, error) {
	raw := strings.TrimSpace(os.Getenv(envLogLevel))
	if raw == "" {
		return slog.LevelInfo, nil
	}

	var level slog.Level
	if err := level.UnmarshalText([]byte(raw)); err != nil {
		return 0, fmt.Errorf("%s=%q is not a log level (debug, info, warn, error): %w", envLogLevel, raw, err)
	}
	return level, nil
}
