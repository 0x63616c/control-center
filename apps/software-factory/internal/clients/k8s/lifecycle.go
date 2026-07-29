package k8s

import (
	"context"
	"fmt"
	"reflect"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/watch"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// deletePoll is how long to wait between checks that a replaced pod has
// actually gone. Short, because grace is zero and the object usually vanishes
// on the first look.
const deletePoll = 200 * time.Millisecond

// Create makes the sandbox pod for one run and returns before it is usable.
//
// It is idempotent, which matters because it runs inside a retrying activity.
// The pod's name carries the run id, so an AlreadyExists can only mean this
// run's own Create is being retried — never that an older run left a pod with a
// different spec and a deadline already ticking. That is what makes adopting
// the existing pod safe rather than a guess.
func (s *Sandboxes) Create(ctx context.Context, spec work.SandboxSpec) (work.SandboxID, error) {
	want, err := buildPod(spec, s.opts)
	if err != nil {
		return "", err
	}

	created, err := s.cs.CoreV1().Pods(s.ns).Create(ctx, want, metav1.CreateOptions{})
	if err == nil {
		s.logger.InfoContext(ctx, "sandbox pod created",
			"sandbox", created.Name, "ticket", spec.TicketNumber, "run_id", spec.RunID,
			"image", spec.Image, "cpu", spec.CPULimit, "memory", spec.MemoryLimit,
			"deadline_seconds", spec.DeadlineSeconds)
		return work.SandboxID(created.Name), nil
	}
	if !apierrors.IsAlreadyExists(err) {
		return "", classify(work.SandboxID(want.Name), "creating the sandbox pod", err)
	}
	return s.reconcileExisting(ctx, spec, want)
}

// reconcileExisting decides what to do about a pod this run's own Create
// already made.
func (s *Sandboxes) reconcileExisting(ctx context.Context, spec work.SandboxSpec, want *corev1.Pod) (work.SandboxID, error) {
	id := work.SandboxID(want.Name)
	const op = "reconciling an existing sandbox pod"

	got, err := s.cs.CoreV1().Pods(s.ns).Get(ctx, want.Name, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			// It went away between the create and the get. The next attempt
			// creates it cleanly, so this is retryable rather than permanent.
			return "", fmt.Errorf("%s %s: it existed a moment ago and is now gone", op, id)
		}
		return "", classify(id, op, err)
	}

	if got.DeletionTimestamp != nil {
		return "", fmt.Errorf("%s %s: it is terminating, so a replacement cannot be created yet", op, id)
	}

	switch got.Status.Phase {
	case corev1.PodPending, corev1.PodRunning:
		if field, ok := specDrift(got, want); !ok {
			// Adopting a pod built to a different spec would silently ignore a
			// change — an image digest bump that never takes effect. Replacing
			// it would destroy this run's completed stage results. Neither is
			// acceptable, so this is an invariant violation and stops here.
			s.logger.ErrorContext(ctx, "refusing to adopt a sandbox pod that drifts from its spec",
				"sandbox", id, "field", field)
			return "", fmt.Errorf("%s %s: it differs from the requested spec at %s: %w", op, id, field, work.ErrPermanent)
		}
		s.logger.InfoContext(ctx, "sandbox pod adopted", "sandbox", id, "phase", got.Status.Phase)
		return id, nil

	case corev1.PodSucceeded, corev1.PodFailed:
		s.logger.WarnContext(ctx, "replacing a terminated sandbox pod",
			"sandbox", id, "phase", got.Status.Phase, "reason", got.Status.Reason)
		if err := s.deleteAndWait(ctx, id); err != nil {
			return "", err
		}
		created, err := s.cs.CoreV1().Pods(s.ns).Create(ctx, want, metav1.CreateOptions{})
		if err != nil {
			return "", classify(id, "recreating the sandbox pod", err)
		}
		s.logger.InfoContext(ctx, "sandbox pod created",
			"sandbox", created.Name, "ticket", spec.TicketNumber, "run_id", spec.RunID,
			"image", spec.Image, "cpu", spec.CPULimit, "memory", spec.MemoryLimit,
			"deadline_seconds", spec.DeadlineSeconds)
		return work.SandboxID(created.Name), nil

	case corev1.PodUnknown:
		return "", fmt.Errorf("%s %s: its phase is %s, so nothing about it can be concluded", op, id, corev1.PodUnknown)

	default:
		return "", fmt.Errorf("%s %s: unrecognised phase %q", op, id, got.Status.Phase)
	}
}

// deleteAndWait removes a pod and waits for the object to disappear, so the
// create that follows does not collide with the corpse it is replacing.
func (s *Sandboxes) deleteAndWait(ctx context.Context, sandbox work.SandboxID) error {
	if err := s.Delete(ctx, sandbox); err != nil {
		return err
	}
	for {
		_, err := s.cs.CoreV1().Pods(s.ns).Get(ctx, string(sandbox), metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return classify(sandbox, "waiting for a replaced sandbox pod to disappear", err)
		}
		if err := s.clk.Sleep(ctx, deletePoll); err != nil {
			return fmt.Errorf("waiting for sandbox %s to disappear: %w", sandbox, err)
		}
	}
}

// specDrift reports the first field in which an existing pod differs from the
// one this spec would build, and whether they match at all.
//
// It compares only what a drift would matter for. Labels, annotations and the
// long tail of fields the apiserver defaults are deliberately excluded: a
// difference there is noise, and treating it as drift would fail every adoption.
func specDrift(got, want *corev1.Pod) (string, bool) {
	if len(got.Spec.Containers) != len(want.Spec.Containers) {
		return "containers", false
	}
	if !equalInt64Ptr(got.Spec.ActiveDeadlineSeconds, want.Spec.ActiveDeadlineSeconds) {
		return "activeDeadlineSeconds", false
	}
	for i, wantC := range want.Spec.Containers {
		gotC := got.Spec.Containers[i]
		if gotC.Image != wantC.Image {
			return "image", false
		}
		if !reflect.DeepEqual(gotC.Command, wantC.Command) {
			return "command", false
		}
		if !reflect.DeepEqual(gotC.Env, wantC.Env) {
			return "env", false
		}
		if !equalResources(gotC.Resources, wantC.Resources) {
			return "resources", false
		}
	}
	return "", true
}

// equalResources compares requests and limits by quantity value, not by the
// struct: two quantities can spell the same amount differently.
func equalResources(got, want corev1.ResourceRequirements) bool {
	return equalResourceList(got.Requests, want.Requests) && equalResourceList(got.Limits, want.Limits)
}

func equalResourceList(got, want corev1.ResourceList) bool {
	if len(got) != len(want) {
		return false
	}
	for name, wantQ := range want {
		gotQ, ok := got[name]
		if !ok || gotQ.Cmp(wantQ) != 0 {
			return false
		}
	}
	return true
}

func equalInt64Ptr(got, want *int64) bool {
	if got == nil || want == nil {
		return got == want
	}
	return *got == *want
}

// WaitReady blocks until the sandbox can serve an exec, or fails saying why it
// never will.
//
// Readiness here is not a probe: the container runs `sleep infinity` and
// declares none, so the kubelet marks it ready as soon as it is running, and
// that is the condition under which pods/exec is served. A failing pod is
// detected rather than waited out — an unpullable image or an expired deadline
// fails here, loudly, instead of at the activity's hour-long timeout.
func (s *Sandboxes) WaitReady(ctx context.Context, sandbox work.SandboxID) error {
	for {
		pod, err := s.cs.CoreV1().Pods(s.ns).Get(ctx, string(sandbox), metav1.GetOptions{})
		if err != nil {
			return classify(sandbox, "getting the sandbox pod", err)
		}
		ready, err := s.readiness(ctx, sandbox, pod)
		if ready || err != nil {
			return err
		}

		w, err := s.cs.CoreV1().Pods(s.ns).Watch(ctx, metav1.ListOptions{
			FieldSelector:   "metadata.name=" + string(sandbox),
			ResourceVersion: pod.ResourceVersion,
		})
		if err != nil {
			return classify(sandbox, "watching the sandbox pod", err)
		}

		ready, cause, err := s.consumeWatch(ctx, sandbox, w)
		w.Stop()
		if err != nil {
			return err
		}
		if ready {
			return nil
		}
		// A plain Watch is used rather than an informer because the resync
		// behaviour an informer buys is exactly this loop, and an informer is
		// far harder to drive deterministically in a test.
		s.logger.DebugContext(ctx, "re-establishing the sandbox pod watch", "sandbox", sandbox, "cause", cause)
	}
}

// consumeWatch reads events until the pod is ready, fails, or the watch ends.
// A false with no error means "re-establish", and cause says why.
func (s *Sandboxes) consumeWatch(ctx context.Context, sandbox work.SandboxID, w watch.Interface) (bool, string, error) {
	for {
		select {
		case <-ctx.Done():
			return false, "", fmt.Errorf("waiting for sandbox %s to become ready: %w", sandbox, ctx.Err())

		case event, open := <-w.ResultChan():
			if !open {
				// A slow image pull outlives a watch window.
				return false, "closed", nil
			}

			switch event.Type {
			case watch.Added, watch.Modified:
				pod, ok := event.Object.(*corev1.Pod)
				if !ok {
					return false, "", fmt.Errorf("watching sandbox %s: the server sent a %T, not a pod: %w", sandbox, event.Object, work.ErrPermanent)
				}
				ready, err := s.readiness(ctx, sandbox, pod)
				if ready || err != nil {
					return ready, "", err
				}

			case watch.Deleted:
				return false, "", fmt.Errorf("waiting for sandbox %s to become ready: it was deleted underneath us: %w", sandbox, work.ErrPermanent)

			case watch.Bookmark:
				// Only a resource-version marker; nothing to decide.

			case watch.Error:
				status, ok := event.Object.(*metav1.Status)
				if !ok {
					return false, "", fmt.Errorf("watching sandbox %s: the server sent an error carrying a %T", sandbox, event.Object)
				}
				if status.Reason == metav1.StatusReasonExpired || status.Code == 410 {
					return false, "expired", nil
				}
				return false, "", classify(sandbox, "watching the sandbox pod", &apierrors.StatusError{ErrStatus: *status})

			default:
				return false, "", fmt.Errorf("watching sandbox %s: unrecognised event type %q", sandbox, event.Type)
			}
		}
	}
}

// readiness reports whether the pod can serve an exec, or returns the reason it
// never will.
func (s *Sandboxes) readiness(ctx context.Context, sandbox work.SandboxID, pod *corev1.Pod) (bool, error) {
	const op = "waiting for the sandbox to become ready"

	container, found := containerStatus(pod, s.opts.containerName)
	state := "absent"
	reason := ""
	if found {
		state, reason = describeState(container.State)
	}
	s.logger.DebugContext(ctx, "sandbox pod status",
		"sandbox", sandbox, "phase", pod.Status.Phase, "container_state", state, "reason", reason)

	switch pod.Status.Phase {
	case corev1.PodFailed, corev1.PodSucceeded:
		return false, classifyPhase(sandbox, op, pod.Status.Phase, pod.Status.Reason, pod.Status.Message)

	case corev1.PodPending, corev1.PodRunning:
		if !found {
			return false, nil
		}
		if err := waitingReasonVerdict(sandbox, op, container.State.Waiting); err != nil {
			return false, err
		}
		return pod.Status.Phase == corev1.PodRunning && container.Ready && container.State.Running != nil, nil

	case corev1.PodUnknown:
		return false, nil

	default:
		return false, fmt.Errorf("%s %s: unrecognised phase %q", op, sandbox, pod.Status.Phase)
	}
}

// waitingReasonVerdict turns a kubelet waiting reason into a verdict, so a pod
// that will never start says so now rather than at the activity timeout.
func waitingReasonVerdict(sandbox work.SandboxID, op string, waiting *corev1.ContainerStateWaiting) error {
	if waiting == nil {
		return nil
	}
	switch waiting.Reason {
	case "InvalidImageName", "CreateContainerConfigError":
		return fmt.Errorf("%s %s: %s: %s: %w", op, sandbox, waiting.Reason, waiting.Message, work.ErrPermanent)
	case "ErrImagePull", "ImagePullBackOff":
		// A registry comes back, so this is the activity's retry policy's
		// decision rather than ours — but it is returned now instead of
		// blocking, so the decision is actually made.
		return fmt.Errorf("%s %s: %s: %s", op, sandbox, waiting.Reason, waiting.Message)
	default:
		return nil
	}
}

// containerStatus finds the sandbox container's status among the pod's.
func containerStatus(pod *corev1.Pod, name string) (corev1.ContainerStatus, bool) {
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.Name == name {
			return cs, true
		}
	}
	return corev1.ContainerStatus{}, false
}

// describeState renders a container state for a log line.
func describeState(state corev1.ContainerState) (string, string) {
	switch {
	case state.Running != nil:
		return "running", ""
	case state.Waiting != nil:
		return "waiting", state.Waiting.Reason
	case state.Terminated != nil:
		return "terminated", state.Terminated.Reason
	default:
		return "unknown", ""
	}
}

// Delete removes a sandbox pod. It does not wait for the object to disappear.
//
// An already-absent pod is success: this is a cleanup path, it runs in a
// retrying activity, and a second delete must not fail a run that has already
// finished its work.
func (s *Sandboxes) Delete(ctx context.Context, sandbox work.SandboxID) error {
	// Grace zero: there is nothing to drain, and on a single-node cluster the
	// capacity a corpse holds is the scarce thing.
	err := s.cs.CoreV1().Pods(s.ns).Delete(ctx, string(sandbox), metav1.DeleteOptions{
		GracePeriodSeconds: ptr(int64(0)),
	})
	if err == nil || apierrors.IsNotFound(err) {
		s.logger.InfoContext(ctx, "sandbox pod deleted", "sandbox", sandbox, "was_present", err == nil)
		return nil
	}
	return classify(sandbox, "deleting the sandbox pod", err)
}
