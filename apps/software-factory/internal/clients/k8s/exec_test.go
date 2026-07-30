package k8s

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"reflect"
	"strings"
	"sync"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	utilexec "k8s.io/client-go/util/exec"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

const testSandbox work.SandboxID = "sandbox-ticket-42-3f1c2a7e"

// streamCall is what the fake observed about one invocation. The context is
// recorded rather than its error, so a test can assert whether the kill exec
// ran on a live context after the caller's had been cancelled.
type streamCall struct {
	target execTarget
	argv   []string
	stdin  []byte
	ctxErr error
}

// answer is what the fake does for one invocation.
type answer struct {
	stdout string
	stderr string
	err    error
	// before runs while the stream is notionally open, which is how a test
	// cancels a command mid-flight.
	before func()
	// stdoutErr, when set, receives the error the stdout writer returned. It is
	// how the read cap's "the stream is aborted, not drained" claim is checked.
	stdoutErr *error
}

// scriptedStreamer answers from a queue, so the *order* of a multi-exec
// operation is assertable. It is the only fake for exec: client-go's fake
// clientset has no pods/exec support of any kind.
type scriptedStreamer struct {
	mu      sync.Mutex
	answers []answer
	calls   []streamCall
}

// errNoStreamsAttached mirrors the real exec subresource: it refuses to
// upgrade a connection that attaches none of stdin/stdout/stderr. #409 was a
// probe that passed all three as nil and broke every stage in production
// without a single test noticing, because this fake used to accept it. Any
// caller of exec must attach at least one stream, even if only to discard it.
var errNoStreamsAttached = errors.New("unable to upgrade connection: you must specify at least 1 of stdin, stdout, stderr")

func (f *scriptedStreamer) stream(ctx context.Context, target execTarget, o streamOpts) error {
	if o.stdin == nil && o.stdout == nil && o.stderr == nil {
		return errNoStreamsAttached
	}

	f.mu.Lock()
	i := len(f.calls)
	var a answer
	if i < len(f.answers) {
		a = f.answers[i]
	}
	var stdin []byte
	if o.stdin != nil {
		stdin, _ = io.ReadAll(o.stdin)
	}
	f.calls = append(f.calls, streamCall{
		target: target,
		argv:   append([]string(nil), o.argv...),
		stdin:  stdin,
		ctxErr: ctx.Err(),
	})
	f.mu.Unlock()

	if a.before != nil {
		a.before()
	}
	if o.stdout != nil && a.stdout != "" {
		if _, err := io.WriteString(o.stdout, a.stdout); err != nil {
			if a.stdoutErr != nil {
				*a.stdoutErr = err
			}
			return err
		}
	}
	if o.stderr != nil && a.stderr != "" {
		_, _ = io.WriteString(o.stderr, a.stderr)
	}
	return a.err
}

func (f *scriptedStreamer) observed() []streamCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]streamCall(nil), f.calls...)
}

// notExitedError implements utilexec.ExitError without ever having exited,
// which is what a stream-setup failure looks like to errors.As.
type notExitedError struct{}

func (notExitedError) Error() string  { return "error executing remote command" }
func (notExitedError) String() string { return "error executing remote command" }
func (notExitedError) Exited() bool   { return false }
func (notExitedError) ExitStatus() int {
	// A value that would be catastrophic to believe: it is neither the real
	// exit code nor a safe default.
	return 3
}

var _ utilexec.ExitError = notExitedError{}

// runningPod is the pod classifyExecFailure finds when the sandbox is healthy
// and only the transport failed.
func runningPod() *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: string(testSandbox), Namespace: "software-factory"},
		Status:     corev1.PodStatus{Phase: corev1.PodRunning},
	}
}

func newTestSandboxes(t *testing.T, str streamer, objects ...runtime.Object) (*Sandboxes, *bytes.Buffer) {
	t.Helper()
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	s, err := newSandboxes(fake.NewSimpleClientset(objects...), str, "software-factory", logger, testClock())
	if err != nil {
		t.Fatalf("newSandboxes returned an unexpected error: %v", err)
	}
	return s, &logs
}

func TestExecReturnsZeroWhenTheCommandExitsSuccessfully(t *testing.T) {
	t.Parallel()

	s, _ := newTestSandboxes(t, &scriptedStreamer{answers: []answer{{}}}, runningPod())
	code, err := s.Exec(context.Background(), testSandbox, []string{"true"}, nil, io.Discard, io.Discard)
	if err != nil {
		t.Fatalf("Exec returned an unexpected error: %v", err)
	}
	if code != 0 {
		t.Errorf("Exec code = %d, want 0", code)
	}
}

func TestExecReturnsTheCommandsRealExitCodeWithoutAnError(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		code int
	}{
		{name: "an ordinary failure", code: 37},
		// 128+9: the CRI reports a signal kill this way, so an OOM-killed
		// stage arrives as a real exit code rather than as a transport error.
		{name: "a signal kill", code: 137},
		{name: "the conventional generic failure", code: 1},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			str := &scriptedStreamer{answers: []answer{{err: utilexec.CodeExitError{Err: errors.New("command terminated"), Code: tc.code}}}}
			s, _ := newTestSandboxes(t, str, runningPod())

			code, err := s.Exec(context.Background(), testSandbox, []string{"codex"}, nil, io.Discard, io.Discard)
			if err != nil {
				t.Fatalf("Exec returned an error for exit %d; a non-zero exit is evidence, not a failure: %v", tc.code, err)
			}
			if code != tc.code {
				t.Errorf("Exec code = %d, want %d", code, tc.code)
			}
		})
	}
}

func TestExecDoesNotTrustAnExitStatusFromAnErrorThatDidNotExit(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{{err: notExitedError{}}}}
	s, _ := newTestSandboxes(t, str, runningPod())

	code, err := s.Exec(context.Background(), testSandbox, []string{"codex"}, nil, io.Discard, io.Discard)
	if err == nil {
		t.Fatal("Exec succeeded on an error that never exited; utilexec.ExitError is an interface and matches values that carry no real status")
	}
	if code != 0 {
		t.Errorf("Exec code = %d, want 0: a code alongside an error would be believed", code)
	}
}

func TestExecReportsAConnectionDropAsAnErrorAndNotAsAnExitCode(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{{err: io.ErrUnexpectedEOF}}}
	s, _ := newTestSandboxes(t, str, runningPod())

	code, err := s.Exec(context.Background(), testSandbox, []string{"codex"}, nil, io.Discard, io.Discard)
	if err == nil {
		t.Fatal("Exec succeeded on a dropped connection")
	}
	if code != 0 {
		t.Errorf("Exec code = %d, want exactly 0: a fabricated 1 would make a healthy stage look failed", code)
	}
	if errors.Is(err, work.ErrPermanent) {
		t.Error("a dropped connection against a Running pod was marked permanent; it is exactly the retryable case")
	}
}

func TestExecReportsAStreamFailureAgainstADeadlineExpiredPodAsPermanent(t *testing.T) {
	t.Parallel()

	dead := runningPod()
	dead.Status = corev1.PodStatus{
		Phase:   corev1.PodFailed,
		Reason:  "DeadlineExceeded",
		Message: "Pod was active on the node longer than the specified deadline",
	}
	str := &scriptedStreamer{answers: []answer{{err: io.ErrUnexpectedEOF}}}
	s, _ := newTestSandboxes(t, str, dead)

	_, err := s.Exec(context.Background(), testSandbox, []string{"codex"}, nil, io.Discard, io.Discard)
	if !errors.Is(err, work.ErrPermanent) {
		t.Fatalf("Exec error = %v, want it permanent: retrying reaches a corpse until the activity times out", err)
	}
	if !strings.Contains(err.Error(), "DeadlineExceeded") {
		t.Errorf("Exec error %q drops the pod's own reason", err)
	}
}

func TestExecReportsAStreamFailureAgainstAVanishedPodAsPermanent(t *testing.T) {
	t.Parallel()

	// No pod seeded, so the Get behind the classification returns NotFound.
	str := &scriptedStreamer{answers: []answer{{err: io.ErrUnexpectedEOF}}}
	s, _ := newTestSandboxes(t, str)

	if _, err := s.Exec(context.Background(), testSandbox, []string{"codex"}, nil, io.Discard, io.Discard); !errors.Is(err, work.ErrPermanent) {
		t.Fatalf("Exec error = %v, want it permanent: the sandbox is gone", err)
	}
}

// TestExecRequiresAtLeastOneStream is the regression test for #409: a caller
// that attaches no stream at all — as Read's existence probe once did — must
// fail the same way the real exec subresource would, not be silently accepted
// by the fake. Before the fix, s.exec passed all three streams through as nil
// and this test failed to see any error at all.
func TestExecRequiresAtLeastOneStream(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{{}}}
	s, _ := newTestSandboxes(t, str, runningPod())

	_, err := s.Exec(context.Background(), testSandbox, []string{"test", "-e", "/work/x"}, nil, nil, nil)
	if err == nil {
		t.Fatal("Exec with no streams attached succeeded, want an error: the real exec subresource refuses this")
	}
}

func TestExecTargetsTheSandboxContainerByName(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{{}}}
	var logs bytes.Buffer
	s, err := newSandboxes(fake.NewSimpleClientset(runningPod()), str, "software-factory",
		slog.New(slog.NewJSONHandler(&logs, nil)), testClock(), WithContainerName("codex-box"))
	if err != nil {
		t.Fatalf("newSandboxes returned an unexpected error: %v", err)
	}
	if _, err := s.Exec(context.Background(), testSandbox, []string{"true"}, nil, io.Discard, io.Discard); err != nil {
		t.Fatalf("Exec returned an unexpected error: %v", err)
	}

	calls := str.observed()
	if len(calls) != 1 {
		t.Fatalf("streamer saw %d calls, want 1", len(calls))
	}
	want := execTarget{pod: testSandbox, container: "codex-box"}
	if calls[0].target != want {
		t.Errorf("streamer target = %+v, want %+v", calls[0].target, want)
	}
}

func TestExecOptionsNeverRequestATTY(t *testing.T) {
	t.Parallel()

	var out bytes.Buffer
	opts := execOptions("sandbox", streamOpts{argv: []string{"cat"}, stdout: &out})
	if opts.TTY {
		t.Error("PodExecOptions.TTY is true; a TTY merges the streams and muddies the exit code")
	}
	if opts.Stdin {
		t.Error("PodExecOptions.Stdin is true with no reader supplied")
	}
	if !opts.Stdout {
		t.Error("PodExecOptions.Stdout is false with a writer supplied")
	}
	if opts.Stderr {
		t.Error("PodExecOptions.Stderr is true with no writer supplied")
	}
	if opts.Container != "sandbox" {
		t.Errorf("PodExecOptions.Container = %q, want %q", opts.Container, "sandbox")
	}
	if !reflect.DeepEqual(opts.Command, []string{"cat"}) {
		t.Errorf("PodExecOptions.Command = %v, want [cat]", opts.Command)
	}
}

func TestExecPassesArgvThroughUntouched(t *testing.T) {
	t.Parallel()

	// Every one of these is inert as argv and dangerous in a shell. They must
	// arrive byte-identical — no shim wraps them any more (#434 deleted
	// cmd/sandbox-exec, the pidfile shim this used to wrap every argv in).
	argv := []string{"codex", "exec", "a b", "it's", "x;rm -rf /", "$(id)", "`id`", "--flag=--flag"}

	str := &scriptedStreamer{answers: []answer{{}}}
	s, _ := newTestSandboxes(t, str, runningPod())
	if _, err := s.Exec(context.Background(), testSandbox, argv, nil, io.Discard, io.Discard); err != nil {
		t.Fatalf("Exec returned an unexpected error: %v", err)
	}

	got := str.observed()[0].argv
	if !reflect.DeepEqual(got, argv) {
		t.Errorf("streamer argv = %v, want %v byte-identical", got, argv)
	}
	for _, a := range got {
		if a == "sh" || a == "bash" || a == "-c" {
			t.Errorf("argv contains %q; there is no shell anywhere on this path", a)
		}
	}
}

func TestExecWritesStdoutAndStderrToTheirSeparateWriters(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{{stdout: "on stdout", stderr: "on stderr"}}}
	s, _ := newTestSandboxes(t, str, runningPod())

	var out, errOut bytes.Buffer
	if _, err := s.Exec(context.Background(), testSandbox, []string{"codex"}, nil, &out, &errOut); err != nil {
		t.Fatalf("Exec returned an unexpected error: %v", err)
	}
	if out.String() != "on stdout" {
		t.Errorf("stdout = %q, want %q", out.String(), "on stdout")
	}
	if errOut.String() != "on stderr" {
		t.Errorf("stderr = %q, want %q", errOut.String(), "on stderr")
	}
}

func TestExecPropagatesCancellationToTheStream(t *testing.T) {
	t.Parallel()

	// #434 deleted cmd/sandbox-exec, the pidfile shim Exec used to send a
	// second, out-of-band kill through on cancellation (see Exec's own doc
	// comment on what this now costs). What remains, and what this still
	// asserts: the stream itself stops and the caller sees context.Canceled —
	// remotecommand's StreamWithContext honours the context on its own.
	ctx, cancel := context.WithCancel(context.Background())
	str := &scriptedStreamer{answers: []answer{
		{before: cancel, err: errors.New("stream torn down")},
	}}
	s, _ := newTestSandboxes(t, str, runningPod())

	code, err := s.Exec(ctx, testSandbox, []string{"sleep", "600"}, nil, io.Discard, io.Discard)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Exec error = %v, want it to wrap context.Canceled", err)
	}
	if code != 0 {
		t.Errorf("Exec code = %d, want 0", code)
	}
	if calls := str.observed(); len(calls) != 1 {
		t.Errorf("streamer saw %d calls, want exactly 1: there is no more out-of-band kill to issue", len(calls))
	}
}

func TestExecRefusesAnEmptyArgv(t *testing.T) {
	t.Parallel()

	s, _ := newTestSandboxes(t, &scriptedStreamer{}, runningPod())
	if _, err := s.Exec(context.Background(), testSandbox, nil, nil, io.Discard, io.Discard); !errors.Is(err, work.ErrPermanent) {
		t.Errorf("Exec error = %v, want it permanent", err)
	}
}

func TestExecLogsTheCommandWithoutItsArguments(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{{}}}
	s, logs := newTestSandboxes(t, str, runningPod())
	if _, err := s.Exec(context.Background(), testSandbox, []string{"codex", "/work/run/plan/prompt.md"}, nil, io.Discard, io.Discard); err != nil {
		t.Fatalf("Exec returned an unexpected error: %v", err)
	}

	out := logs.String()
	if !strings.Contains(out, `"argv0":"codex"`) {
		t.Errorf("logs %q do not name the command", out)
	}
	if strings.Contains(out, "/work/run/plan/prompt.md") {
		t.Error("the full argv reached the logs; it carries paths today and could carry more later")
	}
	if !strings.Contains(out, "sandbox exec finished") || !strings.Contains(out, `"exit_code":0`) {
		t.Errorf("logs %q do not record the exec's outcome", out)
	}
}
