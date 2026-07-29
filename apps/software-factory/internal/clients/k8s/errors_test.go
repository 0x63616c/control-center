package k8s

import (
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// timeoutError is a net.Error, which is how a stalled connection reaches
// classify.
type timeoutError struct{}

func (timeoutError) Error() string   { return "i/o timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }

var podsResource = schema.GroupResource{Resource: "pods"}

func TestClassifiesKubernetesApiErrorsAsPermanentOrRetryable(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		err  error
		// permanent is what the caller must be told: a retry cannot fix it.
		permanent bool
		// ctxErr is the context error the caller must see unwrapped, if any.
		ctxErr error
	}{
		{name: "unauthorized", err: apierrors.NewUnauthorized("no token"), permanent: true},
		{name: "forbidden", err: apierrors.NewForbidden(podsResource, "sandbox-ticket-42", errors.New("rbac")), permanent: true},
		{name: "invalid", err: apierrors.NewInvalid(schema.GroupKind{Kind: "Pod"}, "sandbox", field.ErrorList{}), permanent: true},
		{name: "bad request", err: apierrors.NewBadRequest("malformed"), permanent: true},
		{name: "method not supported", err: apierrors.NewMethodNotSupported(podsResource, "patch"), permanent: true},
		{name: "request entity too large", err: apierrors.NewRequestEntityTooLargeError("2Gi"), permanent: true},
		{name: "not found", err: apierrors.NewNotFound(podsResource, "sandbox-ticket-42"), permanent: true},
		{name: "conflict", err: apierrors.NewConflict(podsResource, "sandbox-ticket-42", errors.New("changed"))},
		{name: "too many requests", err: apierrors.NewTooManyRequests("slow down", 1)},
		{name: "server timeout", err: apierrors.NewServerTimeout(podsResource, "get", 1)},
		{name: "timeout", err: apierrors.NewTimeoutError("gave up", 1)},
		{name: "internal error", err: apierrors.NewInternalError(errors.New("boom"))},
		{name: "service unavailable", err: apierrors.NewServiceUnavailable("no backend")},
		{name: "resource expired", err: apierrors.NewResourceExpired("too old")},
		{name: "a network timeout", err: timeoutError{}},
		{name: "an unexpected eof mid-stream", err: io.ErrUnexpectedEOF},
		{name: "an error from no known family", err: errors.New("something else")},
		{name: "a cancelled context", err: context.Canceled, ctxErr: context.Canceled},
		{name: "an expired context", err: context.DeadlineExceeded, ctxErr: context.DeadlineExceeded},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got := classify("sandbox-ticket-42", "getting the pod", tc.err)
			if got == nil {
				t.Fatal("classify returned nil for a non-nil error")
			}
			if !errors.Is(got, tc.err) {
				t.Errorf("classify(%v) = %v, which does not wrap the original", tc.err, got)
			}
			if isPermanent := errors.Is(got, work.ErrPermanent); isPermanent != tc.permanent {
				t.Errorf("classify(%v) permanent = %v, want %v", tc.err, isPermanent, tc.permanent)
			}
			if tc.ctxErr != nil && errors.Is(got, work.ErrPermanent) {
				t.Errorf("classify(%v) marked a context error permanent; Temporal owns cancellation", tc.err)
			}
			if !strings.Contains(got.Error(), "sandbox-ticket-42") {
				t.Errorf("classify error %q does not name the sandbox it happened to", got)
			}
			if !strings.Contains(got.Error(), "getting the pod") {
				t.Errorf("classify error %q does not name the operation that failed", got)
			}
		})
	}
}

func TestClassifiesAMissingSandboxBinaryAsPermanent(t *testing.T) {
	t.Parallel()

	// 126 is "found but not executable", 127 is "not on PATH". Both mean the
	// sandbox image is missing something this package contracted for, which is
	// a build bug rather than a moment.
	for _, code := range []int{126, 127} {
		err := exitCodeError("sandbox-ticket-42", "probing for a file", []string{"test", "-e", "/work/x"}, code, "")
		if !errors.Is(err, work.ErrPermanent) {
			t.Errorf("exit %d = %v, want it permanent: the image is missing a binary", code, err)
		}
	}
	err := exitCodeError("sandbox-ticket-42", "reading a file", []string{"cat", "/work/x"}, 1, "no such file")
	if errors.Is(err, work.ErrPermanent) {
		t.Errorf("exit 1 = %v, want it retryable: only a missing binary is permanent", err)
	}
	if !strings.Contains(err.Error(), "no such file") {
		t.Errorf("exit-code error %q drops the captured stderr, which is the evidence", err)
	}
}

func TestErrorsNameTheProgramAndNeverTheRestOfTheArgv(t *testing.T) {
	t.Parallel()

	// An argv carries file paths today and could carry more later; an error
	// reaches Temporal history and Loki, so it redacts exactly as the exec
	// Debug line does.
	const sensitive = "/work/3f1c2a7e/plan/credential"
	argv := []string{"codex", "exec", "--config", sensitive}

	messages := []string{
		argvSummary(argv),
		exitCodeError("sandbox-ticket-42", "running a stage", argv, 1, "boom").Error(),
		exitCodeError("sandbox-ticket-42", "running a stage", argv, exitNotFound, "").Error(),
	}
	for _, msg := range messages {
		if !strings.Contains(msg, `"codex"`) {
			t.Errorf("%q does not name argv0, which is what distinguishes tar from cat from codex", msg)
		}
		for _, word := range argv[1:] {
			if strings.Contains(msg, word) {
				t.Errorf("%q carries the argv word %q", msg, word)
			}
		}
	}
	if got, want := argvSummary(argv), `"codex" (4 words)`; got != want {
		t.Errorf("argvSummary = %q, want %q", got, want)
	}
	if got := argvSummary(nil); got == "" || strings.Contains(got, "[]") {
		t.Errorf("argvSummary(nil) = %q, want it to read as a sentence", got)
	}
}

func TestClassifiesAPodStatusPhase(t *testing.T) {
	t.Parallel()

	cases := []struct {
		phase     string
		permanent bool
		// noVerdict means the phase says nothing about the failure and the
		// transport error decides instead.
		noVerdict bool
	}{
		{phase: "Failed", permanent: true},
		{phase: "Succeeded", permanent: true},
		{phase: "Running", noVerdict: true},
		{phase: "Pending"},
		{phase: "Unknown"},
	}

	for _, tc := range cases {
		t.Run(tc.phase, func(t *testing.T) {
			t.Parallel()
			got := classifyPhase("sandbox-ticket-42", "streaming", corev1.PodPhase(tc.phase), "DeadlineExceeded", "pod was active past its deadline")
			if tc.noVerdict {
				if got != nil {
					t.Fatalf("classifyPhase(Running) = %v, want nil so the transport error decides", got)
				}
				return
			}
			if got == nil {
				t.Fatal("classifyPhase returned nil")
			}
			if isPermanent := errors.Is(got, work.ErrPermanent); isPermanent != tc.permanent {
				t.Errorf("phase %s permanent = %v, want %v", tc.phase, isPermanent, tc.permanent)
			}
			if tc.permanent && !strings.Contains(got.Error(), "DeadlineExceeded") {
				t.Errorf("error %q drops the pod's own reason, which is the whole diagnosis", got)
			}
		})
	}
}

func TestClassifyPassesANilErrorThrough(t *testing.T) {
	t.Parallel()

	if got := classify("sandbox-ticket-42", "getting the pod", nil); got != nil {
		t.Errorf("classify(nil) = %v, want nil", got)
	}
}

func TestIsNotFoundStaysDistinguishableAfterClassification(t *testing.T) {
	t.Parallel()

	// Delete maps a vanished pod to nil, which it can only do if the apierrors
	// predicate still answers through the wrapping.
	err := classify("sandbox-ticket-42", "deleting the pod", apierrors.NewNotFound(podsResource, "sandbox-ticket-42"))
	if !apierrors.IsNotFound(err) {
		t.Errorf("apierrors.IsNotFound(%v) = false; wrapping must not hide the status reason", err)
	}
}

var _ = net.Error(timeoutError{})
