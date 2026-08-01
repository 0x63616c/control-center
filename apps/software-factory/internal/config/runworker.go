package config

import (
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// RunWorker is the non-secret startup contract for cmd/run-worker. The pod
// receives renewable credentials only through projected files.
type RunWorker struct {
	ID                work.RunWorkerID
	Identity          work.RunWorkerIdentity
	TaskQueue         string
	TemporalHostPort  string
	TemporalNamespace string
	BlobsURL          string
	CheckpointAPIURL  string
	LogLevel          slog.Level
}

func runWorkerEnvNames() []string {
	return []string{
		work.RunWorkerIDEnv,
		work.RunWorkerRunIDEnv,
		work.RunWorkerGenerationEnv,
		work.RunWorkerTaskQueueEnv,
		work.RunWorkerTemporalHostPortEnv,
		work.RunWorkerTemporalNamespaceEnv,
		work.RunWorkerBlobsURLEnv,
		work.RunWorkerCheckpointAPIURLEnv,
	}
}

// Validate reports whether this process can poll exactly its own private queue.
func (w RunWorker) Validate() error {
	required := map[string]string{
		work.RunWorkerIDEnv:                string(w.ID),
		work.RunWorkerRunIDEnv:             w.Identity.RunID,
		work.RunWorkerTaskQueueEnv:         w.TaskQueue,
		work.RunWorkerTemporalHostPortEnv:  w.TemporalHostPort,
		work.RunWorkerTemporalNamespaceEnv: w.TemporalNamespace,
		work.RunWorkerBlobsURLEnv:          w.BlobsURL,
		work.RunWorkerCheckpointAPIURLEnv:  w.CheckpointAPIURL,
	}
	for _, name := range runWorkerEnvNames() {
		if name == work.RunWorkerGenerationEnv {
			continue
		}
		if strings.TrimSpace(required[name]) == "" {
			return fmt.Errorf("%s is required", name)
		}
	}
	if err := w.Identity.Validate(); err != nil {
		return err
	}
	if want := work.RunWorkerName(w.Identity); w.ID != want {
		return fmt.Errorf("%s=%q does not match Run %q generation %d (want %q)", work.RunWorkerIDEnv, w.ID, w.Identity.RunID, w.Identity.Generation, want)
	}
	if want := work.RunWorkerTaskQueue(w.Identity.RunID, w.Identity.Generation); w.TaskQueue != want {
		return fmt.Errorf("%s=%q does not match Run %q generation %d (want %q)", work.RunWorkerTaskQueueEnv, w.TaskQueue, w.Identity.RunID, w.Identity.Generation, want)
	}
	return nil
}

// LoadRunWorker reads cmd/run-worker's non-secret environment.
func LoadRunWorker() (RunWorker, error) {
	generationRaw := strings.TrimSpace(os.Getenv(work.RunWorkerGenerationEnv))
	if generationRaw == "" {
		return RunWorker{}, fmt.Errorf("%s is required", work.RunWorkerGenerationEnv)
	}
	generation, err := strconv.Atoi(generationRaw)
	if err != nil {
		return RunWorker{}, fmt.Errorf("%s=%q is not a generation number: %w", work.RunWorkerGenerationEnv, generationRaw, err)
	}
	cfg := RunWorker{
		ID:                work.RunWorkerID(os.Getenv(work.RunWorkerIDEnv)),
		Identity:          work.RunWorkerIdentity{RunID: os.Getenv(work.RunWorkerRunIDEnv), Generation: generation},
		TaskQueue:         os.Getenv(work.RunWorkerTaskQueueEnv),
		TemporalHostPort:  os.Getenv(work.RunWorkerTemporalHostPortEnv),
		TemporalNamespace: os.Getenv(work.RunWorkerTemporalNamespaceEnv),
		BlobsURL:          os.Getenv(work.RunWorkerBlobsURLEnv),
		CheckpointAPIURL:  os.Getenv(work.RunWorkerCheckpointAPIURLEnv),
	}
	if err := cfg.Validate(); err != nil {
		return RunWorker{}, err
	}
	cfg.LogLevel, err = logLevel()
	if err != nil {
		return RunWorker{}, err
	}
	return cfg, nil
}
