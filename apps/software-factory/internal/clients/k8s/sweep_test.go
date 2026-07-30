package k8s

import (
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// sweepNow is the instant every sweep test runs at, so a pod's age is the
// difference between two literals rather than a race with the wall clock.
var sweepNow = time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)

// sandboxPod is a sandbox pod for one run, created age ago, labelled the way
// Create labels one.
func sandboxPod(ticket int, runID string, age time.Duration) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "sandbox-ticket-" + strconv.Itoa(ticket) + "-" + runID,
			Namespace: "software-factory",
			Labels: map[string]string{
				labelName:      labelNameValue,
				labelManagedBy: labelManagedByValue,
				labelTicket:    strconv.Itoa(ticket),
				labelRunID:     runID,
			},
			CreationTimestamp: metav1.NewTime(sweepNow.Add(-age)),
		},
	}
}

// sandboxSecret is a per-ticket credential Secret for one run, created age
// ago, labelled the way ensureCredentialSecret labels one — the same scheme
// sandboxPod uses, which is what lets one sweep attribute both by selector.
func sandboxSecret(ticket int, runID string, age time.Duration) *corev1.Secret {
	return &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      credentialSecretName(work.SandboxID("sandbox-ticket-" + strconv.Itoa(ticket) + "-" + runID)),
			Namespace: "software-factory",
			Labels: map[string]string{
				labelName:      labelNameValue,
				labelManagedBy: labelManagedByValue,
				labelTicket:    strconv.Itoa(ticket),
				labelRunID:     runID,
			},
			CreationTimestamp: metav1.NewTime(sweepNow.Add(-age)),
		},
	}
}

// foreignPod is somebody else's pod in the same namespace: no sandbox labels,
// old enough that only the selector keeps it alive.
func foreignPod(name string) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:              name,
			Namespace:         "software-factory",
			Labels:            map[string]string{"app.kubernetes.io/name": "something-else"},
			CreationTimestamp: metav1.NewTime(sweepNow.Add(-99 * time.Hour)),
		},
	}
}

// newSweeper builds a Sandboxes over the given pods, with the clock pinned to
// sweepNow.
func newSweeper(t *testing.T, objects ...runtime.Object) (*Sandboxes, *fake.Clientset) {
	t.Helper()

	cs := fake.NewSimpleClientset(objects...)
	s, err := newSandboxes(cs, nil, "software-factory", discardLogger(), testClock())
	if err != nil {
		t.Fatalf("newSandboxes: %v", err)
	}
	return s, cs
}

// survivors names the pods still in the namespace, so a test asserts what is
// left rather than what was called.
func survivors(t *testing.T, cs *fake.Clientset) map[string]bool {
	t.Helper()

	list, err := cs.CoreV1().Pods("software-factory").List(t.Context(), metav1.ListOptions{})
	if err != nil {
		t.Fatalf("listing pods: %v", err)
	}
	left := map[string]bool{}
	for _, pod := range list.Items {
		left[pod.Name] = true
	}
	return left
}

// secretSurvivors names the credential Secrets still in the namespace.
func secretSurvivors(t *testing.T, cs *fake.Clientset) map[string]bool {
	t.Helper()

	list, err := cs.CoreV1().Secrets("software-factory").List(t.Context(), metav1.ListOptions{})
	if err != nil {
		t.Fatalf("listing secrets: %v", err)
	}
	left := map[string]bool{}
	for _, secret := range list.Items {
		left[secret.Name] = true
	}
	return left
}

// TestSweepNeverDeletesAPodThatCouldStillBeInUse is the test this whole file
// exists for. Everything else here is bookkeeping; this is the blast radius.
func TestSweepNeverDeletesAPodThatCouldStillBeInUse(t *testing.T) {
	t.Parallel()

	live := sandboxPod(101, "run-live", 4*time.Hour)
	young := sandboxPod(102, "run-young", 30*time.Second)
	youngAndLive := sandboxPod(103, "run-young-live", time.Second)
	orphan := sandboxPod(104, "run-orphan", 4*time.Hour)
	foreign := foreignPod("grafana-0")

	s, cs := newSweeper(t, live, young, youngAndLive, orphan, foreign)

	deleted, err := s.SweepOrphans(t.Context(), []string{"run-live", "run-young-live"}, 15*time.Minute)
	if err != nil {
		t.Fatalf("SweepOrphans: %v", err)
	}
	if deleted != 1 {
		t.Errorf("deleted = %d, want 1", deleted)
	}

	left := survivors(t, cs)
	cases := []struct {
		pod  string
		want bool
		why  string
	}{
		{pod: live.Name, want: true, why: "its run is live; deleting it kills a ticket mid-stage"},
		{pod: young.Name, want: true, why: "a pod is created before its run is recorded, so the age floor is what stops the sweep racing the run that owns it"},
		{pod: youngAndLive.Name, want: true, why: "live and under the floor; either reason alone is enough"},
		{pod: foreign.Name, want: true, why: "it is not ours: the selector is what keeps this sweep inside its own blast radius"},
		{pod: orphan.Name, want: false, why: "old, and no live run owns it — this is the only pod a sweep may take"},
	}
	for _, tc := range cases {
		if left[tc.pod] != tc.want {
			t.Errorf("pod %s present = %t, want %t: %s", tc.pod, left[tc.pod], tc.want, tc.why)
		}
	}
}

func TestSweepRefusesToRunWithoutAnAgeFloor(t *testing.T) {
	t.Parallel()

	for _, minAge := range []time.Duration{0, -time.Second, -time.Hour} {
		t.Run(minAge.String(), func(t *testing.T) {
			t.Parallel()

			pod := sandboxPod(101, "run-a", 4*time.Hour)
			s, cs := newSweeper(t, pod)

			deleted, err := s.SweepOrphans(t.Context(), nil, minAge)
			if err == nil {
				t.Fatal("a sweep with no age floor was allowed; it would delete pods out from under their own runs")
			}
			// Permanent, not transient. A retry of this call does the same
			// wrong thing again, and the caller cannot fix it by waiting.
			if !errors.Is(err, work.ErrPermanent) {
				t.Errorf("error %v is not permanent; Temporal would retry a sweep that can only ever be wrong", err)
			}
			if deleted != 0 {
				t.Errorf("deleted = %d, want 0", deleted)
			}
			if !survivors(t, cs)[pod.Name] {
				t.Error("the pod was deleted anyway")
			}
		})
	}
}

func TestSweepWithNoLiveRunsStillHonoursTheAgeFloor(t *testing.T) {
	t.Parallel()

	// An idle system legitimately has no live runs, so an empty set cannot be
	// rejected. The floor is the only thing between a caller that computed the
	// live set wrongly and every sandbox in the namespace.
	young := sandboxPod(101, "run-young", time.Minute)
	old := sandboxPod(102, "run-old", 2*time.Hour)
	s, cs := newSweeper(t, young, old)

	deleted, err := s.SweepOrphans(t.Context(), nil, 15*time.Minute)
	if err != nil {
		t.Fatalf("SweepOrphans: %v", err)
	}
	if deleted != 1 {
		t.Errorf("deleted = %d, want 1", deleted)
	}
	left := survivors(t, cs)
	if !left[young.Name] {
		t.Error("a pod under the age floor was swept with an empty live set")
	}
	if left[old.Name] {
		t.Error("the orphan survived")
	}
}

func TestSweepIsExactlyAtTheFloorInclusive(t *testing.T) {
	t.Parallel()

	// The boundary is stated rather than left to whichever comparison someone
	// typed: a pod aged exactly minAge is old enough.
	atFloor := sandboxPod(101, "run-at-floor", 15*time.Minute)
	s, cs := newSweeper(t, atFloor)

	deleted, err := s.SweepOrphans(t.Context(), nil, 15*time.Minute)
	if err != nil {
		t.Fatalf("SweepOrphans: %v", err)
	}
	if deleted != 1 || survivors(t, cs)[atFloor.Name] {
		t.Errorf("a pod aged exactly the floor was not swept (deleted=%d)", deleted)
	}
}

func TestSweepKeepsGoingWhenOneDeleteFails(t *testing.T) {
	t.Parallel()

	first := sandboxPod(101, "run-a", time.Hour)
	second := sandboxPod(102, "run-b", time.Hour)
	s, cs := newSweeper(t, first, second)

	cs.PrependReactor("delete", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		if action.(k8stesting.DeleteAction).GetName() == first.Name {
			return true, nil, apierrors.NewInternalError(errors.New("etcd is having a moment"))
		}
		return false, nil, nil
	})

	deleted, err := s.SweepOrphans(t.Context(), nil, time.Minute)
	// Stopping at the first failure would leave the rest of the orphans for a
	// sweep that runs on the orphan grace — and hit the same pod again.
	if err == nil {
		t.Fatal("SweepOrphans hid a failed delete")
	}
	if deleted != 1 {
		t.Errorf("deleted = %d, want 1: the sweep should have carried on past the failure", deleted)
	}
	if survivors(t, cs)[second.Name] {
		t.Error("the second orphan was never attempted")
	}
}

func TestSweepCountsAPodThatWasAlreadyGone(t *testing.T) {
	t.Parallel()

	orphan := sandboxPod(101, "run-a", time.Hour)
	s, cs := newSweeper(t, orphan)

	cs.PrependReactor("delete", "pods", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewNotFound(corev1.Resource("pods"), orphan.Name)
	})

	// The sweep wants the pod gone, and it is. Reporting that as a failure
	// would make a clean race look like a broken sweep.
	deleted, err := s.SweepOrphans(t.Context(), nil, time.Minute)
	if err != nil {
		t.Fatalf("SweepOrphans: %v", err)
	}
	if deleted != 1 {
		t.Errorf("deleted = %d, want 1", deleted)
	}
}

func TestSweepReportsAFailureToListWithoutDeletingAnything(t *testing.T) {
	t.Parallel()

	s, cs := newSweeper(t)
	cs.PrependReactor("list", "pods", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(corev1.Resource("pods"), "", errors.New("no list permission"))
	})

	deleted, err := s.SweepOrphans(t.Context(), nil, time.Minute)
	if err == nil {
		t.Fatal("SweepOrphans reported success after failing to list")
	}
	if deleted != 0 {
		t.Errorf("deleted = %d, want 0", deleted)
	}
	// A missing RBAC verb is a real possibility here — the Role has to grant
	// list as well as delete — and a sweep that could not see the namespace
	// must not report "nothing to do".
	if errors.Is(err, work.ErrPermanent) {
		t.Error("a list failure was marked permanent; an apiserver that refused once may not refuse next time")
	}
}

func TestSweepAsksTheApiserverForItsOwnPodsOnly(t *testing.T) {
	t.Parallel()

	s, cs := newSweeper(t)
	var selectors []string
	cs.PrependReactor("list", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		selectors = append(selectors, action.(k8stesting.ListAction).GetListRestrictions().Labels.String())
		return false, nil, nil
	})

	if _, err := s.SweepOrphans(t.Context(), nil, time.Minute); err != nil {
		t.Fatalf("SweepOrphans: %v", err)
	}
	if len(selectors) != 1 {
		t.Fatalf("listed %d times, want 1", len(selectors))
	}
	// Filtering after the fact would work until the day someone runs this in a
	// namespace with other workloads in it. The selector is what makes "ours"
	// the apiserver's answer rather than ours.
	for _, want := range []string{labelName + "=" + labelNameValue, labelManagedBy + "=" + labelManagedByValue} {
		if !strings.Contains(selectors[0], want) {
			t.Errorf("list selector %q does not restrict on %q", selectors[0], want)
		}
	}
}

func TestSweepKeepsAPodItCannotAttributeOrAge(t *testing.T) {
	t.Parallel()

	// Both of these are pods Create cannot produce — podName rejects an empty
	// run id, and the apiserver stamps a creation timestamp. They are here
	// because every other decision in this file fails towards keeping a pod,
	// and these two were the only ones that failed towards deleting one.
	unattributable := sandboxPod(101, "run-a", 4*time.Hour)
	delete(unattributable.Labels, labelRunID)
	unattributable.Name = "sandbox-ticket-101-unlabelled"

	undateable := sandboxPod(102, "run-b", 4*time.Hour)
	undateable.CreationTimestamp = metav1.Time{}

	orphan := sandboxPod(103, "run-c", 4*time.Hour)

	s, cs := newSweeper(t, unattributable, undateable, orphan)

	deleted, err := s.SweepOrphans(t.Context(), nil, 15*time.Minute)
	if err != nil {
		t.Fatalf("SweepOrphans: %v", err)
	}
	if deleted != 1 {
		t.Errorf("deleted = %d, want 1", deleted)
	}

	left := survivors(t, cs)
	cases := []struct {
		pod  string
		want bool
		why  string
	}{
		{
			pod: unattributable.Name, want: true,
			why: "no run id means it cannot be matched against the live set, and an unattributable pod is not the same as an unowned one",
		},
		{
			pod: undateable.Name, want: true,
			why: "a zero creation timestamp reads as the zero time, which is older than every floor — the one case where an anomaly would age a pod into deletion",
		},
		{pod: orphan.Name, want: false, why: "attributable, dateable, old and unowned"},
	}
	for _, tc := range cases {
		if left[tc.pod] != tc.want {
			t.Errorf("pod %s present = %t, want %t: %s", tc.pod, left[tc.pod], tc.want, tc.why)
		}
	}
}

// TestSweepDeletesAnOrphanedCredentialSecretWithNoPod is the case
// sweepOrphanSecrets exists for: Create wrote the credential Secret and never
// got as far as a pod for it to belong to (its own Create call failed, or was
// never retried to completion) — sandboxSelector() over Pods alone would
// never see this Secret at all.
func TestSweepDeletesAnOrphanedCredentialSecretWithNoPod(t *testing.T) {
	t.Parallel()

	orphanSecret := sandboxSecret(101, "run-orphan", 4*time.Hour)
	liveSecret := sandboxSecret(102, "run-live", 4*time.Hour)
	youngSecret := sandboxSecret(103, "run-young", 30*time.Second)

	s, cs := newSweeper(t, orphanSecret, liveSecret, youngSecret)

	deleted, err := s.SweepOrphans(t.Context(), []string{"run-live"}, 15*time.Minute)
	if err != nil {
		t.Fatalf("SweepOrphans: %v", err)
	}
	if deleted != 1 {
		t.Errorf("deleted = %d, want 1", deleted)
	}

	left := secretSurvivors(t, cs)
	cases := []struct {
		secret string
		want   bool
		why    string
	}{
		{secret: liveSecret.Name, want: true, why: "its run is live"},
		{secret: youngSecret.Name, want: true, why: "under the age floor, the same protection a pod gets against the create-then-record race"},
		{secret: orphanSecret.Name, want: false, why: "old, unowned, and has no pod for the pod-sweep to have caught it through"},
	}
	for _, tc := range cases {
		if left[tc.secret] != tc.want {
			t.Errorf("secret %s present = %t, want %t: %s", tc.secret, left[tc.secret], tc.want, tc.why)
		}
	}
}

// TestSweepDeletingAnOrphanedPodDoesNotDoubleCountItsSecret proves the two
// passes compose rather than collide: Delete already removes a pod's
// credential Secret, so sweepOrphanSecrets must find it already gone and
// count it as such — never a second deletion, never a failure.
func TestSweepDeletingAnOrphanedPodDoesNotDoubleCountItsSecret(t *testing.T) {
	t.Parallel()

	pod := sandboxPod(101, "run-orphan", 4*time.Hour)
	secret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{
		Name:      credentialSecretName(work.SandboxID(pod.Name)),
		Namespace: "software-factory",
		Labels: map[string]string{
			labelName: labelNameValue, labelManagedBy: labelManagedByValue,
			labelTicket: "101", labelRunID: "run-orphan",
		},
		CreationTimestamp: metav1.NewTime(sweepNow.Add(-4 * time.Hour)),
	}}
	s, cs := newSweeper(t, pod, secret)

	deleted, err := s.SweepOrphans(t.Context(), nil, 15*time.Minute)
	if err != nil {
		t.Fatalf("SweepOrphans: %v", err)
	}
	// One orphan, one deletion counted for the pod's own sweep pass; the
	// secret pass finds it already gone (Delete removed both together) and
	// counts nothing further for it.
	if deleted != 1 {
		t.Errorf("deleted = %d, want 1 — the pod pass's own Delete already removed the secret", deleted)
	}
	if secretSurvivors(t, cs)[secret.Name] {
		t.Error("the credential secret survived sweeping its own orphaned pod")
	}
}

// TestSweepAsksTheApiserverForItsOwnSecretsOnlyToo is
// TestSweepAsksTheApiserverForItsOwnPodsOnly's counterpart for Secrets: the
// same selector, restricting the second List the same way the first is
// restricted, so this sweep stays inside its own blast radius in a namespace
// that holds other Secrets too.
func TestSweepAsksTheApiserverForItsOwnSecretsOnlyToo(t *testing.T) {
	t.Parallel()

	s, cs := newSweeper(t)
	var selectors []string
	cs.PrependReactor("list", "secrets", func(action k8stesting.Action) (bool, runtime.Object, error) {
		selectors = append(selectors, action.(k8stesting.ListAction).GetListRestrictions().Labels.String())
		return false, nil, nil
	})

	if _, err := s.SweepOrphans(t.Context(), nil, time.Minute); err != nil {
		t.Fatalf("SweepOrphans: %v", err)
	}
	if len(selectors) != 1 {
		t.Fatalf("listed secrets %d times, want 1", len(selectors))
	}
	for _, want := range []string{labelName + "=" + labelNameValue, labelManagedBy + "=" + labelManagedByValue} {
		if !strings.Contains(selectors[0], want) {
			t.Errorf("secret list selector %q does not restrict on %q", selectors[0], want)
		}
	}
}

// TestSweepKeepsASecretItCannotAttributeOrAge is
// TestSweepKeepsAPodItCannotAttributeOrAge's counterpart for Secrets.
func TestSweepKeepsASecretItCannotAttributeOrAge(t *testing.T) {
	t.Parallel()

	unattributable := sandboxSecret(101, "run-a", 4*time.Hour)
	delete(unattributable.Labels, labelRunID)

	undateable := sandboxSecret(102, "run-b", 4*time.Hour)
	undateable.CreationTimestamp = metav1.Time{}

	orphan := sandboxSecret(103, "run-c", 4*time.Hour)

	s, cs := newSweeper(t, unattributable, undateable, orphan)

	deleted, err := s.SweepOrphans(t.Context(), nil, 15*time.Minute)
	if err != nil {
		t.Fatalf("SweepOrphans: %v", err)
	}
	if deleted != 1 {
		t.Errorf("deleted = %d, want 1", deleted)
	}

	left := secretSurvivors(t, cs)
	cases := []struct {
		secret string
		want   bool
		why    string
	}{
		{secret: unattributable.Name, want: true, why: "no run id means it cannot be matched against the live set"},
		{secret: undateable.Name, want: true, why: "a zero creation timestamp is the one anomaly that would otherwise age it into deletion"},
		{secret: orphan.Name, want: false, why: "attributable, dateable, old and unowned"},
	}
	for _, tc := range cases {
		if left[tc.secret] != tc.want {
			t.Errorf("secret %s present = %t, want %t: %s", tc.secret, left[tc.secret], tc.want, tc.why)
		}
	}
}
