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
	// DatabaseURL is the factory Postgres connection the dispatcher writes its
	// per-tick state to (#551). Same variable name as the API's
	// (DatabaseURLEnv, database.go) — one Postgres, one spelling, whichever
	// process is reading it.
	DatabaseURL string

	// TemporalHostPort is the frontend to dial, host:port.
	TemporalHostPort string

	// TemporalNamespace is the namespace this service's workflows live in.
	TemporalNamespace string

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

	// TranscriptsRoot is where stage transcripts are written, the mount point
	// of the worker's transcript volume. Read rather than assumed because the
	// deploy owns the mount path, and a worker writing somewhere else writes to
	// the pod's own filesystem — which looks like success until the pod goes.
	TranscriptsRoot string

	// TemporalUIBaseURL is the ORIGIN of the Temporal UI, scheme and host with
	// no path: whoever builds a run's URL appends the path grammar. The deploy
	// owns the address, and nothing else in this service learns how the UI
	// spells a run.
	TemporalUIBaseURL string

	// CodexAuthSecretName is the Kubernetes Secret holding the codex
	// credential.
	//
	// It is read rather than hardcoded because the deploy pins the worker's
	// Role to this exact name with `resourceNames` (infra/src/software-factory.ts).
	// A second spelling in Go would be a grant that covers nothing, and it
	// fails as Forbidden rather than as a bad credential — which sends whoever
	// debugs it to the credential layer instead of to RBAC.
	CodexAuthSecretName string

	// SandboxImagePullSecretName is the Kubernetes Secret every sandbox pod
	// authenticates its image pull with. The sandbox image is private on
	// GHCR, like the worker's own — but unlike the worker's Deployment, a pod
	// podspec.go builds has no Pulumi-managed spec to set imagePullSecrets on
	// by hand, so this name has to arrive as config and be threaded onto each
	// pod explicitly (k8s.WithImagePullSecret).
	//
	// It is read rather than assumed because there is no cluster-side
	// fallback: an empty value here is a pod with no imagePullSecrets at all,
	// which reads as a healthy Create followed by an ErrImagePull rather than
	// as a startup failure (#404).
	SandboxImagePullSecretName string

	// LogLevel is the level everything below this process logs at.
	LogLevel slog.Level

	// SandboxCPURequest and SandboxMemoryLimit are the per-ticket sandbox
	// pod's CPU request and memory limit, as Kubernetes quantity strings
	// ("2", "8Gi"). There is deliberately no CPU limit: CPU is compressible
	// and #87 banned limiting it repo-wide, so only a request is configured
	// here (see podspec.go). Memory is incompressible, so it keeps both a
	// request and a limit.
	//
	// Optional, like LogLevel: nothing deploys them today (#340 landed the
	// worker's own composition ahead of a resourced deploy for the sandbox
	// pods it creates), and a default that lets a first deploy create a
	// working pod is worth more here than a crashloop over a number nobody
	// has decided is wrong yet. Once infra sets these explicitly the default
	// stops mattering; until then they are real resource settings, not
	// placeholders that skip enforcement.
	SandboxCPURequest  string
	SandboxMemoryLimit string
}

// Defaults for the two optional sandbox resource settings. See their fields'
// doc comment on Worker for why they default rather than fail.
//
// defaultSandboxMemoryLimit is set from a measurement, not a guess: #493
// measured `bun run typecheck` peaking at 6.92Gi inside the sandbox image,
// against the previous 4Gi limit — which is why #479's runs died mid-implement.
// 8Gi is 1.16x that peak, a deliberate near-term unblock rather than a
// comfortable margin; #492 (bounding tsc's fan-out) is the real fix for the
// peak itself.
const (
	defaultSandboxCPURequest  = "2"
	defaultSandboxMemoryLimit = "8Gi"
)

// Environment variables LoadWorker reads. They are constants because the errors
// quote them, and an error naming an input that does not exist is worse than no
// error at all.
const (
	// envDatabaseURL reuses DatabaseURLEnv (database.go), the one spelling of
	// this variable name, rather than a second literal that could drift from it.
	envDatabaseURL            = DatabaseURLEnv
	envTemporalHostPort       = "TEMPORAL_HOST_PORT"
	envTemporalNamespace      = "TEMPORAL_NAMESPACE"
	envSandboxNamespace       = "SANDBOX_NAMESPACE"
	envSandboxImage           = "SANDBOX_IMAGE"
	envMetricsAddr            = "METRICS_ADDR"
	envPodName                = "POD_NAME"
	envTranscriptsRoot        = "TRANSCRIPTS_ROOT"
	envTemporalUIBaseURL      = "TEMPORAL_UI_BASE_URL"
	envCodexAuthSecret        = "CODEX_AUTH_SECRET_NAME"
	envSandboxImagePullSecret = "SANDBOX_IMAGE_PULL_SECRET_NAME"
	envLogLevel               = "LOG_LEVEL"

	envSandboxCPURequest  = "SANDBOX_CPU_REQUEST"
	envSandboxMemoryLimit = "SANDBOX_MEMORY_LIMIT"
)

// workerEnvNames are the variables that must be set. LOG_LEVEL is absent
// deliberately: it is the one input with a safe default.
func workerEnvNames() []string {
	return []string{
		envDatabaseURL,
		envTemporalHostPort,
		envTemporalNamespace,
		envSandboxNamespace,
		envSandboxImage,
		envMetricsAddr,
		envPodName,
		envTranscriptsRoot,
		envTemporalUIBaseURL,
		envCodexAuthSecret,
		envSandboxImagePullSecret,
	}
}

// Validate reports whether this config can start a worker.
//
// It exists beside LoadWorker because a Worker can also be built by hand, and a
// constructor handed a half-filled struct must fail at construction rather than
// at the first poll.
func (w Worker) Validate() error {
	required := map[string]string{
		envDatabaseURL:            w.DatabaseURL,
		envTemporalHostPort:       w.TemporalHostPort,
		envTemporalNamespace:      w.TemporalNamespace,
		envSandboxNamespace:       w.SandboxNamespace,
		envSandboxImage:           w.SandboxImage,
		envMetricsAddr:            w.MetricsAddr,
		envPodName:                w.PodName,
		envTranscriptsRoot:        w.TranscriptsRoot,
		envTemporalUIBaseURL:      w.TemporalUIBaseURL,
		envCodexAuthSecret:        w.CodexAuthSecretName,
		envSandboxImagePullSecret: w.SandboxImagePullSecretName,
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
		DatabaseURL:       os.Getenv(envDatabaseURL),
		TemporalHostPort:  os.Getenv(envTemporalHostPort),
		TemporalNamespace: os.Getenv(envTemporalNamespace),
		SandboxNamespace:  os.Getenv(envSandboxNamespace),
		SandboxImage:      os.Getenv(envSandboxImage),
		MetricsAddr:       os.Getenv(envMetricsAddr),
		PodName:           os.Getenv(envPodName),

		TranscriptsRoot:     os.Getenv(envTranscriptsRoot),
		TemporalUIBaseURL:   os.Getenv(envTemporalUIBaseURL),
		CodexAuthSecretName: os.Getenv(envCodexAuthSecret),

		SandboxImagePullSecretName: os.Getenv(envSandboxImagePullSecret),
	}
	if err := cfg.Validate(); err != nil {
		return Worker{}, describeWorkerRequirement(err)
	}

	level, err := logLevel()
	if err != nil {
		return Worker{}, err
	}
	cfg.LogLevel = level

	cfg.SandboxCPURequest = orDefault(envSandboxCPURequest, defaultSandboxCPURequest)
	cfg.SandboxMemoryLimit = orDefault(envSandboxMemoryLimit, defaultSandboxMemoryLimit)
	return cfg, nil
}

// orDefault reads an optional environment variable, or returns fallback if it
// is unset or blank.
func orDefault(name, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return fallback
}

// describeWorkerRequirement adds to a missing-variable error what the variable
// is for, so the person reading it in a crashloop does not have to find this
// file to fix their Deployment.
func describeWorkerRequirement(err error) error {
	purposes := map[string]string{
		envDatabaseURL:            "the factory Postgres connection the dispatcher writes its per-tick state to",
		envTemporalHostPort:       "the Temporal frontend to dial, host:port",
		envTemporalNamespace:      "the Temporal namespace this service's workflows live in",
		envSandboxNamespace:       "the Kubernetes namespace per-ticket sandbox pods are created in",
		envSandboxImage:           "the per-ticket sandbox image, pinned by digest",
		envMetricsAddr:            "the address the metrics and health server listens on",
		envPodName:                "this pod's own name, from the downward API; it identifies the credential lease holder",
		envTranscriptsRoot:        "the mount point of the transcript volume, where stage transcripts are written",
		envTemporalUIBaseURL:      "the Temporal UI's origin, scheme and host with no path; run URLs are built from it",
		envCodexAuthSecret:        "the Kubernetes Secret holding the codex credential; the worker's Role is pinned to this exact name",
		envSandboxImagePullSecret: "the Kubernetes Secret every sandbox pod authenticates its image pull with; without it a sandbox pod ErrImagePulls against GHCR",
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
