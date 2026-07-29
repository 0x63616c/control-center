package work

import (
	"testing"
	"time"
)

// The ladder these constants form is the reason they live together. Each test
// below is a relationship, not a value: changing one duration is meant to fail
// here so whoever tunes it re-derives the rest rather than discovering the
// consequence in production at 3am.

func TestAHeartbeatTimeoutCanFireWithinAStage(t *testing.T) {
	t.Parallel()

	// A heartbeat timeout at or above the stage length can never fire, which
	// is a 60-minute black box wearing a liveness check.
	if StageHeartbeatTimeout >= MaxStageDuration {
		t.Errorf("StageHeartbeatTimeout (%s) is not shorter than MaxStageDuration (%s): a stage could never be declared dead",
			StageHeartbeatTimeout, MaxStageDuration)
	}
}

func TestARunCanContainItsStages(t *testing.T) {
	t.Parallel()

	stages := time.Duration(len(Pipeline())) * MaxStageDuration
	if MaxRunDuration <= stages {
		t.Errorf("MaxRunDuration (%s) does not exceed the %d stages it contains (%s): a run would time out while a stage was still legitimately working",
			MaxRunDuration, len(Pipeline()), stages)
	}
}

func TestKubernetesNeverKillsAPodTemporalStillBelievesIn(t *testing.T) {
	t.Parallel()

	// ADR-0011: activeDeadlineSeconds sits above the workflow run timeout. The
	// other order gives a stage whose sandbox vanished under it, reported as a
	// exec failure with no cause.
	if SandboxDeadline <= MaxRunDuration {
		t.Errorf("SandboxDeadline (%s) does not exceed MaxRunDuration (%s): Kubernetes would delete a sandbox a live run still expects",
			SandboxDeadline, MaxRunDuration)
	}
}

func TestSandboxDeadlineSecondsIsThatDeadlineInSeconds(t *testing.T) {
	t.Parallel()

	// It is handed to a Kubernetes field measured in seconds. A units mistake
	// here is a pod that dies in minutes or outlives the cluster.
	if want := int64(SandboxDeadline / time.Second); SandboxDeadlineSeconds != want {
		t.Errorf("SandboxDeadlineSeconds = %d, want %d", SandboxDeadlineSeconds, want)
	}
	if SandboxDeadlineSeconds <= 0 {
		t.Errorf("SandboxDeadlineSeconds = %d; Kubernetes reads a non-positive activeDeadlineSeconds as no deadline at all", SandboxDeadlineSeconds)
	}
}

func TestEveryDurationIsPositive(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		d    time.Duration
	}{
		{name: "MaxStageDuration", d: MaxStageDuration},
		{name: "StageHeartbeatTimeout", d: StageHeartbeatTimeout},
		{name: "MaxRunDuration", d: MaxRunDuration},
		{name: "SandboxDeadline", d: SandboxDeadline},
	}

	for _, tc := range cases {
		if tc.d <= 0 {
			t.Errorf("%s is %s; every constructor here rejects a non-positive duration", tc.name, tc.d)
		}
	}
}
