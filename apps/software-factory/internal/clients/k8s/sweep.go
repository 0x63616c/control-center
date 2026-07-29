package k8s

import (
	"context"
	"errors"
	"fmt"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// sandboxSelector matches the pods this service created and nothing else.
//
// It is built from the labels Create stamps rather than from the pod's name,
// which is the reason those labels exist. Names are a format that changes; a
// selector is a query the apiserver answers, and it is what keeps this sweep
// inside its own blast radius in a namespace that holds anything else.
func sandboxSelector() string {
	return labels.SelectorFromSet(labels.Set{
		labelName:      labelNameValue,
		labelManagedBy: labelManagedByValue,
	}).String()
}

// SweepOrphans deletes sandbox pods that no live run owns and that are older
// than minAge, and returns how many it removed.
//
// It exists because a pod outlives the thing that would have deleted it. A
// worker that dies mid-ticket takes its WorkTicket workflow with it, and the
// pod it created answers to nobody — so the dispatcher, the only long-lived
// thing here, reconciles them. Nothing else is positioned to.
//
// Two independent conditions keep a pod alive, and a pod needs only one of
// them:
//
//   - Its run id is in live. That set is the caller's view of which runs are
//     still open.
//   - It is younger than minAge. A pod is created before its run is recorded as
//     live, so without a floor this sweep races the very run that owns the pod
//     it is about to delete. The floor is also the only defence against a
//     caller that computed live wrongly — an empty live set is legitimate on an
//     idle system and cannot be rejected, so age is what stands between a bug
//     upstream and every sandbox in the namespace.
//
// minAge is therefore required, and a non-positive one is refused permanently
// rather than transiently: a retry of a sweep with no floor does the same wrong
// thing again, and no amount of waiting makes it right. The caller guards this
// too — that is deliberate duplication, not redundancy, because the cost of it
// being wrong is live pods deleted out from under running tickets.
//
// A delete that fails does not stop the sweep. The next one runs on the orphan
// grace, so abandoning the remaining orphans would leave them for a pass that
// meets the same failure; the failures are collected and reported together
// while every other orphan is still attempted.
func (s *Sandboxes) SweepOrphans(ctx context.Context, live []string, minAge time.Duration) (int, error) {
	if minAge <= 0 {
		return 0, fmt.Errorf(
			"sweeping orphaned sandboxes: a minimum age of %s would delete pods out from under their own runs: %w",
			minAge, work.ErrPermanent)
	}

	pods, err := s.cs.CoreV1().Pods(s.ns).List(ctx, metav1.ListOptions{LabelSelector: sandboxSelector()})
	if err != nil {
		// Transient by default, and that includes a Forbidden: this needs the
		// list verb as well as delete, and a Role that is being fixed is not a
		// reason to stop trying. What must never happen is reporting "nothing
		// to sweep" for a namespace we could not see.
		return 0, fmt.Errorf("listing sandbox pods in %s: %w", s.ns, err)
	}

	stillLive := make(map[string]bool, len(live))
	for _, runID := range live {
		stillLive[runID] = true
	}

	now := s.clk.Now()
	deleted := 0
	var failures []error

	for _, pod := range pods.Items {
		if stillLive[pod.Labels[labelRunID]] {
			continue
		}
		if age := now.Sub(pod.CreationTimestamp.Time); age < minAge {
			continue
		}

		// Delete treats an already-absent pod as success, which is what this
		// wants: the sweep's goal is the pod's absence, and a pod that lost a
		// race to something else is a sweep that got what it came for.
		if err := s.Delete(ctx, work.SandboxID(pod.Name)); err != nil {
			failures = append(failures, err)
			continue
		}
		deleted++
		s.logger.WarnContext(ctx, "swept an orphaned sandbox",
			"sandbox", pod.Name,
			"ticket", pod.Labels[labelTicket],
			"run_id", pod.Labels[labelRunID],
			"age_seconds", int64(now.Sub(pod.CreationTimestamp.Time).Seconds()),
		)
	}

	if len(failures) > 0 {
		return deleted, fmt.Errorf("sweeping orphaned sandboxes in %s: %w", s.ns, errors.Join(failures...))
	}
	return deleted, nil
}
