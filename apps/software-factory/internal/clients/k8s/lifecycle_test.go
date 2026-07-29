package k8s

import (
	"context"
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock/clocktest"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// seededPod is the pod a spec would have produced, so an adoption test differs
// from a create in exactly the field it is about.
func seededPod(t *testing.T, spec work.SandboxSpec, phase corev1.PodPhase) *corev1.Pod {
	t.Helper()
	pod, err := buildPod(spec, defaultOptions())
	if err != nil {
		t.Fatalf("buildPod returned an unexpected error: %v", err)
	}
	pod.Namespace = "software-factory"
	pod.Status.Phase = phase
	return pod
}

// verbs lists what a fake clientset was asked to do, in order, so a test can
// assert that a create did *not* happen.
func verbs(cs *fake.Clientset) []string {
	var out []string
	for _, a := range cs.Actions() {
		out = append(out, a.GetVerb())
	}
	return out
}

func newLifecycleSandboxes(t *testing.T, objects ...runtime.Object) (*Sandboxes, *fake.Clientset, *strings.Builder) {
	t.Helper()
	s, cs, logs, _ := newLifecycleSandboxesWithClock(t, objects...)
	return s, cs, logs
}

// newLifecycleSandboxesWithClock also hands back the fake clock, so a test can
// assert on what the code waited for rather than waiting for it.
func newLifecycleSandboxesWithClock(t *testing.T, objects ...runtime.Object) (*Sandboxes, *fake.Clientset, *strings.Builder, *clocktest.Fake) {
	t.Helper()
	cs := fake.NewSimpleClientset(objects...)
	logs := &strings.Builder{}
	logger := slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	clk := testClock()
	s, err := newSandboxes(cs, &scriptedStreamer{}, "software-factory", logger, clk)
	if err != nil {
		t.Fatalf("newSandboxes returned an unexpected error: %v", err)
	}
	return s, cs, logs, clk
}

func TestCreateCreatesThePodAndReturnsItsSandboxID(t *testing.T) {
	t.Parallel()

	s, cs, _ := newLifecycleSandboxes(t)
	got, err := s.Create(context.Background(), validSpec())
	if err != nil {
		t.Fatalf("Create returned an unexpected error: %v", err)
	}
	if want := work.SandboxID("sandbox-ticket-42-3f1c2a7e-0000-4000-8000-000000000001"); got != want {
		t.Errorf("Create = %q, want %q", got, want)
	}
	if len(cs.Actions()) != 1 || cs.Actions()[0].GetVerb() != "create" {
		t.Errorf("actions = %v, want exactly one create", verbs(cs))
	}
}

func TestCreateAdoptsAMatchingPodLeftByItsOwnRetry(t *testing.T) {
	t.Parallel()

	spec := validSpec()
	for _, phase := range []corev1.PodPhase{corev1.PodPending, corev1.PodRunning} {
		t.Run(strings.ToLower(string(phase)), func(t *testing.T) {
			t.Parallel()
			s, cs, logs := newLifecycleSandboxes(t, seededPod(t, spec, phase))

			got, err := s.Create(context.Background(), spec)
			if err != nil {
				t.Fatalf("Create returned an unexpected error: %v", err)
			}
			if want := work.SandboxID("sandbox-ticket-42-3f1c2a7e-0000-4000-8000-000000000001"); got != want {
				t.Errorf("Create = %q, want the existing pod %q", got, want)
			}
			// One failed create, one get, and nothing else. A second create
			// would mean the adoption never happened.
			creates := 0
			for _, v := range verbs(cs) {
				if v == "create" {
					creates++
				}
			}
			if creates != 1 {
				t.Errorf("actions = %v, want exactly one (rejected) create", verbs(cs))
			}
			if !strings.Contains(logs.String(), "adopted") {
				t.Errorf("logs %q do not record the adoption decision", logs.String())
			}
		})
	}
}

func TestCreateRefusesToAdoptAPodThatDriftsFromTheSpec(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		field string
		drift func(*corev1.Pod)
	}{
		{
			name: "whose image differs", field: "image",
			// The regression: without this, a sandbox-image digest bump
			// silently never takes effect for any ticket with a live pod.
			drift: func(p *corev1.Pod) {
				p.Spec.Containers[0].Image = "ghcr.io/0x63616c/sandbox@sha256:" + strings.Repeat("b", 64)
			},
		},
		{
			name: "whose resource limits differ", field: "resources",
			drift: func(p *corev1.Pod) {
				p.Spec.Containers[0].Resources.Limits[corev1.ResourceMemory] = resourceQuantity(t, "8Gi")
			},
		},
		{
			name: "whose deadline differs", field: "activeDeadlineSeconds",
			drift: func(p *corev1.Pod) { p.Spec.ActiveDeadlineSeconds = ptr(int64(60)) },
		},
		{
			name: "whose command differs", field: "command",
			drift: func(p *corev1.Pod) { p.Spec.Containers[0].Command = []string{"sleep", "60"} },
		},
		{
			name: "whose environment differs", field: "env",
			drift: func(p *corev1.Pod) {
				p.Spec.Containers[0].Env = append(p.Spec.Containers[0].Env, corev1.EnvVar{Name: "EXTRA", Value: "1"})
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			spec := validSpec()
			pod := seededPod(t, spec, corev1.PodRunning)
			tc.drift(pod)

			s, cs, logs := newLifecycleSandboxes(t, pod)
			_, err := s.Create(context.Background(), spec)
			if !errors.Is(err, work.ErrPermanent) {
				t.Fatalf("Create error = %v, want it permanent: a drifting spec under an identical name is an invariant violation", err)
			}
			if !strings.Contains(err.Error(), tc.field) {
				t.Errorf("Create error %q does not name the differing field %q", err, tc.field)
			}
			for _, v := range verbs(cs) {
				if v == "delete" {
					t.Error("Create deleted a drifted pod; replacing it would destroy this run's completed stage results")
				}
			}
			if !strings.Contains(logs.String(), tc.field) {
				t.Errorf("logs %q do not record which field drifted", logs.String())
			}
		})
	}
}

func TestCreateReplacesAPodLeftTerminatedByAnEarlierAttempt(t *testing.T) {
	t.Parallel()

	for _, phase := range []corev1.PodPhase{corev1.PodSucceeded, corev1.PodFailed} {
		t.Run(strings.ToLower(string(phase)), func(t *testing.T) {
			t.Parallel()
			spec := validSpec()
			pod := seededPod(t, spec, phase)
			pod.Status.Reason = "DeadlineExceeded"

			s, cs, logs := newLifecycleSandboxes(t, pod)
			if _, err := s.Create(context.Background(), spec); err != nil {
				t.Fatalf("Create returned an unexpected error: %v", err)
			}

			// Order is the assertion: a create before the delete would collide
			// with the corpse it is meant to replace.
			seen := verbs(cs)
			deleteAt, createAt := -1, -1
			for i, v := range seen {
				if v == "delete" && deleteAt < 0 {
					deleteAt = i
				}
				if v == "create" && i > deleteAt && deleteAt >= 0 {
					createAt = i
					break
				}
			}
			if deleteAt < 0 || createAt < 0 {
				t.Fatalf("actions = %v, want a delete followed by a create", seen)
			}
			if !strings.Contains(logs.String(), "DeadlineExceeded") {
				t.Errorf("logs %q do not say why the pod was replaced", logs.String())
			}
		})
	}
}

func TestCreateRefusesToAdoptAPodThatIsTerminating(t *testing.T) {
	t.Parallel()

	spec := validSpec()
	pod := seededPod(t, spec, corev1.PodRunning)
	now := metav1.NewTime(testClock().Now())
	pod.DeletionTimestamp = &now

	s, _, _ := newLifecycleSandboxes(t, pod)
	_, err := s.Create(context.Background(), spec)
	if err == nil {
		t.Fatal("Create adopted a terminating pod")
	}
	if errors.Is(err, work.ErrPermanent) {
		t.Error("Create marked a terminating pod permanent; the next retry finds it gone and succeeds")
	}
}

func TestCreateRefusesToGuessAboutAPodInAnUnknownPhase(t *testing.T) {
	t.Parallel()

	spec := validSpec()
	s, _, _ := newLifecycleSandboxes(t, seededPod(t, spec, corev1.PodUnknown))

	_, err := s.Create(context.Background(), spec)
	if err == nil {
		t.Fatal("Create made a decision about a pod in an unknown phase")
	}
	if errors.Is(err, work.ErrPermanent) {
		t.Error("Create marked an unknown phase permanent; nothing about it is known, including that")
	}
	if !strings.Contains(err.Error(), string(corev1.PodUnknown)) {
		t.Errorf("Create error %q does not name the phase", err)
	}
}

func TestCreateReportsAForbiddenCreateAsPermanent(t *testing.T) {
	t.Parallel()

	s, cs, _ := newLifecycleSandboxes(t)
	cs.PrependReactor("create", "pods", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "pods"}, "sandbox", errors.New("no create verb"))
	})

	if _, err := s.Create(context.Background(), validSpec()); !errors.Is(err, work.ErrPermanent) {
		t.Errorf("Create error = %v, want it permanent: a missing RBAC verb is not a moment", err)
	}
}

func TestCreateRejectsASpecItCannotBuildAPodFor(t *testing.T) {
	t.Parallel()

	s, cs, _ := newLifecycleSandboxes(t)
	spec := validSpec()
	spec.CPULimit = "2x"

	if _, err := s.Create(context.Background(), spec); !errors.Is(err, work.ErrPermanent) {
		t.Fatalf("Create error = %v, want it permanent", err)
	}
	if len(cs.Actions()) != 0 {
		t.Errorf("actions = %v, want none: an unbuildable spec never reaches the apiserver", verbs(cs))
	}
}

func TestCreateLogsWhatItCreated(t *testing.T) {
	t.Parallel()

	s, _, logs := newLifecycleSandboxes(t)
	if _, err := s.Create(context.Background(), validSpec()); err != nil {
		t.Fatalf("Create returned an unexpected error: %v", err)
	}
	for _, field := range []string{"ticket", "run_id", "image", "cpu", "memory", "deadline_seconds"} {
		if !strings.Contains(logs.String(), `"`+field+`"`) {
			t.Errorf("logs %q do not carry %q", logs.String(), field)
		}
	}
}

func TestDeleteDeletesThePodWithNoGracePeriod(t *testing.T) {
	t.Parallel()

	s, cs, _ := newLifecycleSandboxes(t, seededPod(t, validSpec(), corev1.PodRunning))
	if err := s.Delete(context.Background(), testSandbox); err != nil {
		t.Fatalf("Delete returned an unexpected error: %v", err)
	}

	var grace *int64
	for _, a := range cs.Actions() {
		if del, ok := a.(k8stesting.DeleteActionImpl); ok {
			grace = del.DeleteOptions.GracePeriodSeconds
		}
	}
	if grace == nil || *grace != 0 {
		t.Errorf("delete grace = %v, want 0: there is nothing to drain and the node's capacity is scarce", grace)
	}
}

func TestDeleteTreatsAnAlreadyAbsentPodAsDeleted(t *testing.T) {
	t.Parallel()

	s, _, _ := newLifecycleSandboxes(t)
	if err := s.Delete(context.Background(), testSandbox); err != nil {
		t.Errorf("Delete returned %v for an absent pod; cleanup must be idempotent under retry", err)
	}
}

func TestDeleteReportsAForbiddenDeleteAsPermanent(t *testing.T) {
	t.Parallel()

	s, cs, _ := newLifecycleSandboxes(t)
	cs.PrependReactor("delete", "pods", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "pods"}, "sandbox", errors.New("no delete verb"))
	})

	if err := s.Delete(context.Background(), testSandbox); !errors.Is(err, work.ErrPermanent) {
		t.Errorf("Delete error = %v, want it permanent", err)
	}
}

// readyPod is a pod whose container the kubelet has reported up. With no probe
// declared, that is the condition under which pods/exec can be served.
func readyPod(t *testing.T, phase corev1.PodPhase, ready bool) *corev1.Pod {
	t.Helper()
	pod := seededPod(t, validSpec(), phase)
	state := corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}
	if !ready {
		state = corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "ContainerCreating"}}
	}
	pod.Status.ContainerStatuses = []corev1.ContainerStatus{{Name: "sandbox", Ready: ready, State: state}}
	return pod
}

func waitingPod(t *testing.T, reason, message string) *corev1.Pod {
	t.Helper()
	pod := seededPod(t, validSpec(), corev1.PodPending)
	pod.Status.ContainerStatuses = []corev1.ContainerStatus{{
		Name:  "sandbox",
		State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: reason, Message: message}},
	}}
	return pod
}

const readySandbox work.SandboxID = "sandbox-ticket-42-3f1c2a7e-0000-4000-8000-000000000001"

func TestWaitReadyReturnsWithoutWatchingAPodThatIsAlreadyReady(t *testing.T) {
	t.Parallel()

	s, cs, _ := newLifecycleSandboxes(t, readyPod(t, corev1.PodRunning, true))
	watches := 0
	cs.PrependWatchReactor("pods", func(k8stesting.Action) (bool, watch.Interface, error) {
		watches++
		return true, watch.NewFake(), nil
	})

	if err := s.WaitReady(context.Background(), readySandbox); err != nil {
		t.Fatalf("WaitReady returned an unexpected error: %v", err)
	}
	if watches != 0 {
		t.Errorf("WaitReady opened %d watches for an already-ready pod, want 0", watches)
	}
}

func TestWaitReadyReturnsOnceTheContainerReportsRunningAndReady(t *testing.T) {
	t.Parallel()

	s, cs, _ := newLifecycleSandboxes(t, readyPod(t, corev1.PodPending, false))
	w := watch.NewRaceFreeFake()
	cs.PrependWatchReactor("pods", func(k8stesting.Action) (bool, watch.Interface, error) {
		return true, w, nil
	})
	w.Modify(readyPod(t, corev1.PodRunning, true))

	if err := s.WaitReady(context.Background(), readySandbox); err != nil {
		t.Fatalf("WaitReady returned an unexpected error: %v", err)
	}
}

func TestWaitReadyDoesNotCallAPodReadyBeforeItsContainerIs(t *testing.T) {
	t.Parallel()

	// Phase Running is not enough: the container can still be creating, and an
	// exec against it fails.
	s, cs, _ := newLifecycleSandboxes(t, readyPod(t, corev1.PodRunning, false))
	w := watch.NewRaceFreeFake()
	cs.PrependWatchReactor("pods", func(k8stesting.Action) (bool, watch.Interface, error) {
		return true, w, nil
	})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.WaitReady(ctx, readySandbox); !errors.Is(err, context.Canceled) {
		t.Fatalf("WaitReady error = %v, want context.Canceled: a Running pod with a creating container is not ready", err)
	}
}

func TestWaitReadyFailsPermanentlyWhenThePodReachesATerminalPhase(t *testing.T) {
	t.Parallel()

	for _, phase := range []corev1.PodPhase{corev1.PodFailed, corev1.PodSucceeded} {
		t.Run(strings.ToLower(string(phase)), func(t *testing.T) {
			t.Parallel()
			pod := readyPod(t, phase, false)
			pod.Status.Reason = "DeadlineExceeded"
			pod.Status.Message = "Pod was active on the node longer than the specified deadline"

			s, _, _ := newLifecycleSandboxes(t, pod)
			err := s.WaitReady(context.Background(), readySandbox)
			if !errors.Is(err, work.ErrPermanent) {
				t.Fatalf("WaitReady error = %v, want it permanent", err)
			}
			for _, want := range []string{"DeadlineExceeded", "longer than the specified deadline"} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("WaitReady error %q does not carry %q", err, want)
				}
			}
		})
	}
}

func TestWaitReadyFailsPermanentlyOnAnImageTheKubeletCanNeverPull(t *testing.T) {
	t.Parallel()

	for _, reason := range []string{"InvalidImageName", "CreateContainerConfigError"} {
		t.Run(reason, func(t *testing.T) {
			t.Parallel()
			s, _, _ := newLifecycleSandboxes(t, waitingPod(t, reason, "bad image reference"))
			if err := s.WaitReady(context.Background(), readySandbox); !errors.Is(err, work.ErrPermanent) {
				t.Errorf("WaitReady error = %v, want it permanent: no retry fixes a malformed reference", err)
			}
		})
	}
}

func TestWaitReadyFailsRetryablyOnImagePullBackoffNamingTheReason(t *testing.T) {
	t.Parallel()

	for _, reason := range []string{"ErrImagePull", "ImagePullBackOff"} {
		t.Run(reason, func(t *testing.T) {
			t.Parallel()
			s, _, _ := newLifecycleSandboxes(t, waitingPod(t, reason, "registry unreachable"))
			err := s.WaitReady(context.Background(), readySandbox)
			if err == nil {
				t.Fatal("WaitReady succeeded on an unpullable image")
			}
			if errors.Is(err, work.ErrPermanent) {
				t.Error("WaitReady marked a pull backoff permanent; a registry comes back")
			}
			for _, want := range []string{reason, "registry unreachable"} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("WaitReady error %q does not carry %q", err, want)
				}
			}
		})
	}
}

func TestWaitReadyFailsPermanentlyWhenThePodIsDeletedUnderneathIt(t *testing.T) {
	t.Parallel()

	s, cs, _ := newLifecycleSandboxes(t, readyPod(t, corev1.PodPending, false))
	w := watch.NewRaceFreeFake()
	cs.PrependWatchReactor("pods", func(k8stesting.Action) (bool, watch.Interface, error) {
		return true, w, nil
	})
	w.Delete(readyPod(t, corev1.PodPending, false))

	err := s.WaitReady(context.Background(), readySandbox)
	if !errors.Is(err, work.ErrPermanent) {
		t.Fatalf("WaitReady error = %v, want it permanent: recreating a sandbox is a different activity", err)
	}
}

func TestWaitReadyReEstablishesTheWatchWhenTheServerExpiresIt(t *testing.T) {
	t.Parallel()

	s, cs, logs := newLifecycleSandboxes(t, readyPod(t, corev1.PodPending, false))

	watches := 0
	expired := watch.NewRaceFreeFake()
	fresh := watch.NewRaceFreeFake()
	cs.PrependWatchReactor("pods", func(k8stesting.Action) (bool, watch.Interface, error) {
		watches++
		if watches == 1 {
			return true, expired, nil
		}
		return true, fresh, nil
	})
	expired.Error(&metav1.Status{Status: metav1.StatusFailure, Reason: metav1.StatusReasonExpired, Code: 410})
	fresh.Modify(readyPod(t, corev1.PodRunning, true))

	if err := s.WaitReady(context.Background(), readySandbox); err != nil {
		t.Fatalf("WaitReady returned an unexpected error: %v", err)
	}
	if watches != 2 {
		t.Errorf("WaitReady opened %d watches, want 2: a 410 must be recovered from, not returned", watches)
	}
	if !strings.Contains(logs.String(), "expired") {
		t.Errorf("logs %q do not say why the watch was re-established", logs.String())
	}
}

func TestWaitReadyReEstablishesTheWatchWhenTheServerClosesIt(t *testing.T) {
	t.Parallel()

	s, cs, logs := newLifecycleSandboxes(t, readyPod(t, corev1.PodPending, false))

	watches := 0
	closed := watch.NewRaceFreeFake()
	fresh := watch.NewRaceFreeFake()
	cs.PrependWatchReactor("pods", func(k8stesting.Action) (bool, watch.Interface, error) {
		watches++
		if watches == 1 {
			return true, closed, nil
		}
		return true, fresh, nil
	})
	// A slow image pull outlives a watch window; the server just closes it.
	closed.Stop()
	fresh.Modify(readyPod(t, corev1.PodRunning, true))

	if err := s.WaitReady(context.Background(), readySandbox); err != nil {
		t.Fatalf("WaitReady returned an unexpected error: %v", err)
	}
	if watches != 2 {
		t.Errorf("WaitReady opened %d watches, want 2", watches)
	}
	if !strings.Contains(logs.String(), "closed") {
		t.Errorf("logs %q do not say why the watch was re-established", logs.String())
	}
}

func TestWaitReadyBacksOffExponentiallyBetweenWatchReconnects(t *testing.T) {
	t.Parallel()

	s, cs, _, clk := newLifecycleSandboxesWithClock(t, readyPod(t, corev1.PodPending, false))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Every watch ends at once with the pod still Pending — what an apiserver
	// rolling restart, or an APF-shed watch during a slow image pull, looks
	// like. With no wait between attempts the loop re-Gets and re-Watches as
	// fast as the shared 5 QPS client bucket allows, starving the Create and
	// Delete of every concurrent ticket for the whole activity timeout.
	const reconnects = 8
	watches := 0
	cs.PrependWatchReactor("pods", func(k8stesting.Action) (bool, watch.Interface, error) {
		watches++
		if watches >= reconnects {
			cancel()
		}
		w := watch.NewRaceFreeFake()
		w.Stop()
		return true, w, nil
	})

	if err := s.WaitReady(ctx, readySandbox); !errors.Is(err, context.Canceled) {
		t.Fatalf("WaitReady error = %v, want context.Canceled", err)
	}

	slept := clk.Slept()
	if len(slept) == 0 {
		t.Fatalf("WaitReady re-established the watch %d times without waiting once; it spins at the client's rate limit", watches)
	}
	want := []time.Duration{
		200 * time.Millisecond,
		400 * time.Millisecond,
		800 * time.Millisecond,
		1600 * time.Millisecond,
		3200 * time.Millisecond,
		5 * time.Second,
		5 * time.Second,
	}
	if !reflect.DeepEqual(slept, want) {
		t.Errorf("backoff schedule = %v, want %v: doubling from %s and capped at %s", slept, want, watchBackoffMin, watchBackoffMax)
	}
}

func TestWaitReadyIgnoresABookmark(t *testing.T) {
	t.Parallel()

	s, cs, _ := newLifecycleSandboxes(t, readyPod(t, corev1.PodPending, false))
	w := watch.NewRaceFreeFake()
	cs.PrependWatchReactor("pods", func(k8stesting.Action) (bool, watch.Interface, error) {
		return true, w, nil
	})
	w.Action(watch.Bookmark, readyPod(t, corev1.PodPending, false))
	w.Modify(readyPod(t, corev1.PodRunning, true))

	if err := s.WaitReady(context.Background(), readySandbox); err != nil {
		t.Errorf("WaitReady returned an unexpected error: %v", err)
	}
}

func TestWaitReadyReportsAVanishedPodAsPermanent(t *testing.T) {
	t.Parallel()

	s, _, _ := newLifecycleSandboxes(t)
	if err := s.WaitReady(context.Background(), readySandbox); !errors.Is(err, work.ErrPermanent) {
		t.Errorf("WaitReady error = %v, want it permanent", err)
	}
}

func TestWaitReadyReturnsTheContextErrorWhenCancelledWhileThePodIsPending(t *testing.T) {
	t.Parallel()

	s, cs, _ := newLifecycleSandboxes(t, readyPod(t, corev1.PodPending, false))
	w := watch.NewRaceFreeFake()
	cs.PrependWatchReactor("pods", func(k8stesting.Action) (bool, watch.Interface, error) {
		return true, w, nil
	})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.WaitReady(ctx, readySandbox); !errors.Is(err, context.Canceled) {
		t.Errorf("WaitReady error = %v, want it to wrap context.Canceled", err)
	}
}

// resourceQuantity parses a quantity for a drift fixture.
func resourceQuantity(t *testing.T, s string) resource.Quantity {
	t.Helper()
	q, err := resource.ParseQuantity(s)
	if err != nil {
		t.Fatalf("parsing quantity %q: %v", s, err)
	}
	return q
}
