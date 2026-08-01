package config

import (
	"log/slog"
	"strings"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

func completeRunWorkerEnv() map[string]string {
	return map[string]string{
		work.RunWorkerIDEnv:                "run-worker-019fb900-0000-7000-8000-000000000001-g1",
		work.RunWorkerRunIDEnv:             "019fb900-0000-7000-8000-000000000001",
		work.RunWorkerGenerationEnv:        "1",
		work.RunWorkerTaskQueueEnv:         "software-factory-run-worker-019fb900-0000-7000-8000-000000000001-g1",
		work.RunWorkerTemporalHostPortEnv:  "temporal-frontend.temporal:7233",
		work.RunWorkerTemporalNamespaceEnv: "software-factory",
		work.RunWorkerBlobsURLEnv:          "http://software-factory-blobs:8080",
		work.RunWorkerCheckpointAPIURLEnv:  "http://software-factory-api:8080",
	}
}

func setRunWorkerEnv(t *testing.T, env map[string]string) {
	t.Helper()
	for _, name := range append(runWorkerEnvNames(), "LOG_LEVEL") {
		t.Setenv(name, "")
	}
	for name, value := range env {
		t.Setenv(name, value)
	}
}

func TestLoadRunWorkerReadsItsTargetOnlyEnvironment(t *testing.T) {
	setRunWorkerEnv(t, completeRunWorkerEnv())

	got, err := LoadRunWorker()
	if err != nil {
		t.Fatalf("LoadRunWorker: %v", err)
	}
	if got.Identity.RunID != "019fb900-0000-7000-8000-000000000001" || got.Identity.Generation != 1 {
		t.Errorf("identity = %+v", got.Identity)
	}
	if got.ID != work.RunWorkerID("run-worker-019fb900-0000-7000-8000-000000000001-g1") {
		t.Errorf("ID = %q", got.ID)
	}
	if got.TaskQueue != work.RunWorkerTaskQueue(got.Identity.RunID, got.Identity.Generation) {
		t.Errorf("TaskQueue = %q, want the queue derived from %+v", got.TaskQueue, got.Identity)
	}
	if got.TemporalHostPort == "" || got.TemporalNamespace == "" || got.BlobsURL == "" || got.CheckpointAPIURL == "" {
		t.Errorf("incomplete config: %+v", got)
	}
	if got.LogLevel != slog.LevelInfo {
		t.Errorf("LogLevel = %v, want info", got.LogLevel)
	}
}

func TestLoadRunWorkerNamesEveryMissingVariable(t *testing.T) {
	for _, missing := range runWorkerEnvNames() {
		t.Run(missing, func(t *testing.T) {
			env := completeRunWorkerEnv()
			delete(env, missing)
			setRunWorkerEnv(t, env)
			_, err := LoadRunWorker()
			if err == nil || !strings.Contains(err.Error(), missing) {
				t.Fatalf("LoadRunWorker without %s = %v", missing, err)
			}
		})
	}
}

func TestLoadRunWorkerRejectsQueueIdentityDrift(t *testing.T) {
	env := completeRunWorkerEnv()
	env[work.RunWorkerTaskQueueEnv] = work.RunWorkerTaskQueue(env[work.RunWorkerRunIDEnv], 2)
	setRunWorkerEnv(t, env)

	_, err := LoadRunWorker()
	if err == nil || !strings.Contains(err.Error(), work.RunWorkerTaskQueueEnv) {
		t.Fatalf("LoadRunWorker accepted a queue for another generation: %v", err)
	}
}
