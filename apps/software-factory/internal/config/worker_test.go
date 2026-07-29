package config

import (
	"log/slog"
	"strings"
	"testing"
)

// completeEnv is a worker environment with nothing missing. A case removes or
// replaces the one variable it is about.
func completeEnv() map[string]string {
	return map[string]string{
		"TEMPORAL_HOST_PORT":  "temporal-frontend.temporal:7233",
		"TEMPORAL_NAMESPACE":  "software-factory",
		"TEMPORAL_TASK_QUEUE": "software-factory",
		"SANDBOX_NAMESPACE":   "software-factory",
		"SANDBOX_IMAGE":       "ghcr.io/0x63616c/www-software-factory-sandbox@sha256:abc",
		"METRICS_ADDR":        ":9090",
		"POD_NAME":            "software-factory-worker-7d9f8c-abcde",
	}
}

// setEnv installs an environment for one test, and clears everything else this
// loader reads so a variable left over from the shell cannot make a test pass.
func setEnv(t *testing.T, env map[string]string) {
	t.Helper()

	for _, name := range append(workerEnvNames(), "LOG_LEVEL") {
		t.Setenv(name, "")
	}
	for name, value := range env {
		t.Setenv(name, value)
	}
}

func TestLoadWorkerReadsTheWholeEnvironment(t *testing.T) {
	setEnv(t, completeEnv())

	got, err := LoadWorker()
	if err != nil {
		t.Fatalf("LoadWorker: %v", err)
	}

	switch {
	case got.TemporalHostPort != "temporal-frontend.temporal:7233":
		t.Errorf("TemporalHostPort = %q", got.TemporalHostPort)
	case got.TemporalNamespace != "software-factory":
		t.Errorf("TemporalNamespace = %q", got.TemporalNamespace)
	case got.TaskQueue != "software-factory":
		t.Errorf("TaskQueue = %q", got.TaskQueue)
	case got.SandboxNamespace != "software-factory":
		t.Errorf("SandboxNamespace = %q", got.SandboxNamespace)
	case got.SandboxImage != "ghcr.io/0x63616c/www-software-factory-sandbox@sha256:abc":
		t.Errorf("SandboxImage = %q", got.SandboxImage)
	case got.MetricsAddr != ":9090":
		t.Errorf("MetricsAddr = %q", got.MetricsAddr)
	case got.PodName != "software-factory-worker-7d9f8c-abcde":
		t.Errorf("PodName = %q", got.PodName)
	case got.LogLevel != slog.LevelInfo:
		t.Errorf("LogLevel = %v, want the default %v", got.LogLevel, slog.LevelInfo)
	}
}

func TestLoadWorkerNamesTheVariableThatIsMissing(t *testing.T) {
	for _, missing := range workerEnvNames() {
		t.Run(missing, func(t *testing.T) {
			env := completeEnv()
			delete(env, missing)
			setEnv(t, env)

			_, err := LoadWorker()
			if err == nil {
				t.Fatalf("LoadWorker succeeded without %s", missing)
			}
			// A config failure at 3am is read by someone who does not know
			// this file. The variable's own name is the whole fix.
			if !strings.Contains(err.Error(), missing) {
				t.Errorf("error %q does not name %s", err, missing)
			}
		})
	}
}

func TestLoadWorkerTakesTheLogLevelItIsGiven(t *testing.T) {
	cases := []struct {
		name  string
		value string
		want  slog.Level
	}{
		{name: "unset is info", value: "", want: slog.LevelInfo},
		{name: "debug for a bad night", value: "debug", want: slog.LevelDebug},
		{name: "case does not matter", value: "WARN", want: slog.LevelWarn},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := completeEnv()
			if tc.value != "" {
				env["LOG_LEVEL"] = tc.value
			}
			setEnv(t, env)

			got, err := LoadWorker()
			if err != nil {
				t.Fatalf("LoadWorker: %v", err)
			}
			if got.LogLevel != tc.want {
				t.Errorf("LogLevel = %v, want %v", got.LogLevel, tc.want)
			}
		})
	}
}

func TestLoadWorkerRefusesALogLevelItCannotRead(t *testing.T) {
	env := completeEnv()
	env["LOG_LEVEL"] = "chatty"
	setEnv(t, env)

	// Falling back to info would start a worker that quietly logs at a level
	// nobody asked for, which is discovered while debugging something else.
	_, err := LoadWorker()
	if err == nil {
		t.Fatal("LoadWorker accepted LOG_LEVEL=chatty")
	}
	if !strings.Contains(err.Error(), "LOG_LEVEL") {
		t.Errorf("error %q does not name LOG_LEVEL", err)
	}
}

func TestWorkerValidateRejectsAHandBuiltHole(t *testing.T) {
	t.Parallel()

	// A Worker can also be built by a test or by another composition root, so
	// the check cannot live only inside the loader.
	var empty Worker
	if err := empty.Validate(); err == nil {
		t.Fatal("an empty Worker validated")
	}
}
