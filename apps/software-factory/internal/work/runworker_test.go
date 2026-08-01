package work

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestRunWorkerTaskQueueIsDeterministicPerRunGeneration(t *testing.T) {
	t.Parallel()

	first := RunWorkerTaskQueue("019fb900-0000-7000-8000-000000000001", 1)
	if got := RunWorkerTaskQueue("019fb900-0000-7000-8000-000000000001", 1); got != first {
		t.Fatalf("same Run and generation produced %q then %q", first, got)
	}
	if got := RunWorkerTaskQueue("019fb900-0000-7000-8000-000000000001", 2); got == first {
		t.Fatalf("replacement generation reused queue %q", got)
	}
	if got := RunWorkerTaskQueue("019fb900-0000-7000-8000-000000000002", 1); got == first {
		t.Fatalf("another Run reused queue %q", got)
	}
	if !strings.HasPrefix(first, "software-factory-run-worker-") {
		t.Errorf("queue %q has no published Run Worker prefix", first)
	}
}

func TestRunWorkerIdentityValidatesRunAndGeneration(t *testing.T) {
	t.Parallel()

	valid := RunWorkerIdentity{RunID: "019fb900-0000-7000-8000-000000000001", Generation: 1}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid identity: %v", err)
	}
	for _, invalid := range []RunWorkerIdentity{
		{},
		{RunID: valid.RunID},
		{RunID: "Not/A Kubernetes Name", Generation: 1},
	} {
		if err := invalid.Validate(); err == nil {
			t.Errorf("identity %+v was accepted", invalid)
		}
	}
}

func TestCredentialRevisionContainsOnlySafeMetadata(t *testing.T) {
	t.Parallel()

	got := RunWorkerCredentialRevision{
		Revision:  "17",
		ExpiresAt: time.Date(2026, 7, 31, 12, 30, 0, 0, time.UTC),
	}
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal revision: %v", err)
	}
	text := string(raw)
	for _, forbidden := range []string{"token", "credential", "secret", "ghs_"} {
		if strings.Contains(strings.ToLower(text), forbidden) {
			t.Errorf("safe metadata JSON %q contains forbidden %q", text, forbidden)
		}
	}
}

func TestRunWorkerPublishedEnvironmentNamesAreTargetSpecific(t *testing.T) {
	t.Parallel()

	want := map[string]string{
		"RunWorkerIDEnv":         "RUN_WORKER_ID",
		"RunWorkerRunIDEnv":      "RUN_ID",
		"RunWorkerGenerationEnv": "RUN_WORKER_GENERATION",
		"RunWorkerTaskQueueEnv":  "RUN_WORKER_TASK_QUEUE",
	}
	got := map[string]string{
		"RunWorkerIDEnv":         RunWorkerIDEnv,
		"RunWorkerRunIDEnv":      RunWorkerRunIDEnv,
		"RunWorkerGenerationEnv": RunWorkerGenerationEnv,
		"RunWorkerTaskQueueEnv":  RunWorkerTaskQueueEnv,
	}
	for name, value := range want {
		if got[name] != value {
			t.Errorf("%s = %q, want %q", name, got[name], value)
		}
	}
}
