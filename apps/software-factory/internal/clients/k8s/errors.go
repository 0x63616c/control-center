package k8s

import (
	"context"
	"errors"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// Exit codes a shell reserves for "the command could not be run". A sandbox
// that answers with either is missing a binary this package contracted for,
// which is a build bug in the image and never a moment worth retrying.
const (
	exitNotExecutable = 126
	exitNotFound      = 127
)

// classify turns a Kubernetes API or transport error into one this service's
// activity layer can act on: everything is retryable unless it is marked with
// work.ErrPermanent, which is the single bit Temporal needs.
//
// It never swallows the original — apierrors' predicates and errors.Is both
// still answer through the wrapping, which is what lets Delete map a vanished
// pod to nil after classification rather than before.
func classify(sandbox work.SandboxID, op string, err error) error {
	if err == nil {
		return nil
	}

	// Cancellation is neither kind. Temporal owns it, and marking it permanent
	// would turn a deliberate stop into a failed ticket.
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%s for sandbox %s: %w", op, sandbox, err)
	}

	if isPermanentAPIError(err) {
		return fmt.Errorf("%s for sandbox %s: %w: %w", op, sandbox, err, work.ErrPermanent)
	}
	return fmt.Errorf("%s for sandbox %s: %w", op, sandbox, err)
}

// isPermanentAPIError reports whether the apiserver has said the request itself
// is wrong, rather than that the moment is.
//
// A missing RBAC verb is the case that matters: without this, a Role short one
// verb costs sixty retries and an hour before anyone finds out.
func isPermanentAPIError(err error) bool {
	switch {
	case apierrors.IsUnauthorized(err), apierrors.IsForbidden(err):
		return true
	case apierrors.IsInvalid(err), apierrors.IsBadRequest(err):
		return true
	case apierrors.IsMethodNotSupported(err), apierrors.IsRequestEntityTooLargeError(err):
		return true
	case apierrors.IsNotFound(err):
		// A vanished pod is permanent for every caller but Delete, which maps
		// it to nil before it ever reaches here.
		return true
	default:
		return false
	}
}

// classifyPhase renders a verdict on a stream failure from the pod's own phase,
// or nil when the phase has nothing to say.
//
// This is what stops a stage retrying into a corpse. An activeDeadlineSeconds
// expiry leaves the pod present in phase Failed, so every exec against it fails
// with an ordinary-looking transport error; without this the stage would retry
// until its own hour-long timeout instead of failing with the reason sitting
// right there in the pod's status.
func classifyPhase(sandbox work.SandboxID, op string, phase corev1.PodPhase, reason, message string) error {
	switch phase {
	case corev1.PodFailed, corev1.PodSucceeded:
		return fmt.Errorf("%s for sandbox %s: the pod is %s (%s: %s): %w",
			op, sandbox, phase, reason, message, work.ErrPermanent)
	case corev1.PodPending:
		// A race with WaitReady: the pod is on its way up, so try again.
		return fmt.Errorf("%s for sandbox %s: the pod is still %s", op, sandbox, phase)
	case corev1.PodUnknown:
		return fmt.Errorf("%s for sandbox %s: the pod's phase is %s, so nothing about it can be concluded", op, sandbox, phase)
	case corev1.PodRunning:
		return nil
	default:
		return fmt.Errorf("%s for sandbox %s: unrecognised pod phase %q", op, sandbox, phase)
	}
}

// exitCodeError reports a command that ran and failed, quoting what it said.
//
// stderr is the evidence and is never dropped: it is the only thing that
// distinguishes a full disk from a missing directory when tar exits 2.
func exitCodeError(sandbox work.SandboxID, op string, argv []string, code int, stderr string) error {
	detail := ""
	if trimmed := strings.TrimSpace(stderr); trimmed != "" {
		detail = ": " + trimmed
	}
	if code == exitNotExecutable || code == exitNotFound {
		return fmt.Errorf("%s in sandbox %s: %q exited %d, so the sandbox image is missing it%s: %w",
			op, sandbox, argv[0], code, detail, work.ErrPermanent)
	}
	return fmt.Errorf("%s in sandbox %s: %v exited %d%s", op, sandbox, argv, code, detail)
}
