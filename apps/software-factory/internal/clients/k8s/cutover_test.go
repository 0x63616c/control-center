package k8s

import (
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

func TestCutoverLegacySandboxBoundaryPreservesRunWorkers(t *testing.T) {
	t.Parallel()
	legacy := sandboxPod(8, "run-8", time.Hour)
	legacy.UID = types.UID("legacy-pod-uid")
	runWorker := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{
		Name:      "run-worker-run-8-g1",
		Namespace: "software-factory",
		UID:       types.UID("run-worker-uid"),
		Labels: map[string]string{
			labelName:       "software-factory-run-worker",
			labelManagedBy:  labelManagedByValue,
			labelTicket:     "8",
			labelRunID:      "run-8",
			labelGeneration: "1",
		},
	}}
	sandboxes, client := newSweeper(t, legacy, runWorker)

	listed, err := sandboxes.ListLegacySandboxes(t.Context())
	if err != nil {
		t.Fatalf("ListLegacySandboxes: %v", err)
	}
	if len(listed) != 1 || listed[0].Name != legacy.Name || listed[0].UID != string(legacy.UID) {
		t.Fatalf("listed = %+v, want only the legacy sandbox", listed)
	}
	if err := sandboxes.DeleteLegacySandbox(t.Context(), listed[0]); err != nil {
		t.Fatalf("DeleteLegacySandbox: %v", err)
	}
	left := survivors(t, client)
	if left[legacy.Name] {
		t.Error("legacy sandbox survived cutover cleanup")
	}
	if !left[runWorker.Name] {
		t.Error("target Run Worker was deleted by legacy cleanup")
	}
}

func TestCutoverDeleteDoesNotDeleteAReplacementPod(t *testing.T) {
	t.Parallel()
	replacement := sandboxPod(8, "run-8", time.Hour)
	replacement.UID = types.UID("replacement-uid")
	sandboxes, client := newSweeper(t, replacement)

	err := sandboxes.DeleteLegacySandbox(t.Context(), LegacySandbox{
		Name: replacement.Name,
		UID:  "inventoried-uid",
	})
	if err != nil {
		t.Fatalf("DeleteLegacySandbox: %v", err)
	}
	if !survivors(t, client)[replacement.Name] {
		t.Error("replacement pod with a different UID was deleted")
	}
}
