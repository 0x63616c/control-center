package config

import (
	"log/slog"
	"strings"
	"testing"
)

// completeSandboxWorkerEnv is a sandbox worker environment with nothing
// missing. A case removes or replaces the one variable it is about.
func completeSandboxWorkerEnv() map[string]string {
	return map[string]string{
		"TEMPORAL_HOST_PORT": "temporal-frontend.temporal:7233",
		"TEMPORAL_NAMESPACE": "software-factory",
		"SANDBOX_TASK_QUEUE": "software-factory-sandbox-b6f1e2b2-1c1e-4b1a-9c1a-1234567890ab",
		"BLOBS_URL":          "http://blobs:8080",
	}
}

// TestTheRequiredSandboxWorkerEnvironmentIsExactlyWhatTheTestsSupply is
// TestTheRequiredEnvironmentIsExactlyWhatTheTestsSupply's counterpart for
// SandboxWorker: it holds sandboxWorkerEnvNames() and completeSandboxWorkerEnv()
// to each other so a name dropped from one without the other stops compiling
// green.
func TestTheRequiredSandboxWorkerEnvironmentIsExactlyWhatTheTestsSupply(t *testing.T) {
	required := make(map[string]bool, len(sandboxWorkerEnvNames()))
	for _, name := range sandboxWorkerEnvNames() {
		required[name] = true
	}
	supplied := make(map[string]bool, len(completeSandboxWorkerEnv()))
	for name := range completeSandboxWorkerEnv() {
		supplied[name] = true
	}

	for name := range supplied {
		if !required[name] {
			t.Errorf("%s is supplied but is not required; either require it or stop supplying it", name)
		}
	}
	for name := range required {
		if !supplied[name] {
			t.Errorf("%s is required but not supplied, so no missing-variable case covers it", name)
		}
	}
}

func setSandboxWorkerEnv(t *testing.T, env map[string]string) {
	t.Helper()

	for _, name := range append(sandboxWorkerEnvNames(), "LOG_LEVEL") {
		t.Setenv(name, "")
	}
	for name, value := range env {
		t.Setenv(name, value)
	}
}

func TestLoadSandboxWorkerReadsTheWholeEnvironment(t *testing.T) {
	setSandboxWorkerEnv(t, completeSandboxWorkerEnv())

	got, err := LoadSandboxWorker()
	if err != nil {
		t.Fatalf("LoadSandboxWorker: %v", err)
	}

	switch {
	case got.TemporalHostPort != "temporal-frontend.temporal:7233":
		t.Errorf("TemporalHostPort = %q", got.TemporalHostPort)
	case got.TemporalNamespace != "software-factory":
		t.Errorf("TemporalNamespace = %q", got.TemporalNamespace)
	case got.TaskQueue != "software-factory-sandbox-b6f1e2b2-1c1e-4b1a-9c1a-1234567890ab":
		t.Errorf("TaskQueue = %q", got.TaskQueue)
	case got.BlobsURL != "http://blobs:8080":
		t.Errorf("BlobsURL = %q", got.BlobsURL)
	case got.LogLevel != slog.LevelInfo:
		t.Errorf("LogLevel = %v, want the default %v", got.LogLevel, slog.LevelInfo)
	}
}

func TestLoadSandboxWorkerNamesTheVariableThatIsMissing(t *testing.T) {
	for _, missing := range sandboxWorkerEnvNames() {
		t.Run(missing, func(t *testing.T) {
			env := completeSandboxWorkerEnv()
			delete(env, missing)
			setSandboxWorkerEnv(t, env)

			_, err := LoadSandboxWorker()
			if err == nil {
				t.Fatalf("LoadSandboxWorker succeeded without %s", missing)
			}
			if !strings.Contains(err.Error(), missing) {
				t.Errorf("error %q does not name %s", err, missing)
			}
		})
	}
}

func TestLoadSandboxWorkerTakesTheLogLevelItIsGiven(t *testing.T) {
	env := completeSandboxWorkerEnv()
	env["LOG_LEVEL"] = "debug"
	setSandboxWorkerEnv(t, env)

	got, err := LoadSandboxWorker()
	if err != nil {
		t.Fatalf("LoadSandboxWorker: %v", err)
	}
	if got.LogLevel != slog.LevelDebug {
		t.Errorf("LogLevel = %v, want %v", got.LogLevel, slog.LevelDebug)
	}
}

func TestLoadSandboxWorkerRefusesALogLevelItCannotRead(t *testing.T) {
	env := completeSandboxWorkerEnv()
	env["LOG_LEVEL"] = "chatty"
	setSandboxWorkerEnv(t, env)

	_, err := LoadSandboxWorker()
	if err == nil {
		t.Fatal("LoadSandboxWorker accepted LOG_LEVEL=chatty")
	}
	if !strings.Contains(err.Error(), "LOG_LEVEL") {
		t.Errorf("error %q does not name LOG_LEVEL", err)
	}
}

func TestSandboxWorkerValidateRejectsAHandBuiltHole(t *testing.T) {
	t.Parallel()

	var empty SandboxWorker
	if err := empty.Validate(); err == nil {
		t.Fatal("an empty SandboxWorker validated")
	}
}
