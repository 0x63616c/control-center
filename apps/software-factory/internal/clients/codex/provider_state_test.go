package codex

import (
	"testing"
	"testing/fstest"
)

func TestRolloutProbeFindsOnlyTheRequestedProviderThread(t *testing.T) {
	t.Parallel()
	probe, err := NewRolloutProbe(fstest.MapFS{"sessions/rollout-thread-live.jsonl": {Data: []byte("event")}})
	if err != nil {
		t.Fatalf("NewRolloutProbe: %v", err)
	}
	if available, err := probe.Available(t.Context(), "thread-live"); err != nil || !available {
		t.Fatalf("Available(thread-live) = (%v, %v)", available, err)
	}
	if available, err := probe.Available(t.Context(), "thread-lost"); err != nil || available {
		t.Fatalf("Available(thread-lost) = (%v, %v)", available, err)
	}
}
