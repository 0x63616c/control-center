package k8s

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"path"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	utilexec "k8s.io/client-go/util/exec"
	"k8s.io/streaming/pkg/httpstream"

	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// shimPath is the sandbox image's exec wrapper, and a contract with that image.
//
// It exists because pods/exec never reports the remote PID, and no argv-only
// coreutils trick recovers one: env and setsid exec-replace themselves so no
// tag survives in the process's cmdline, and pkill -f against the joined argv
// is ambiguous exactly when it matters — two attempts of the same stage. The
// shim is the only mechanism that yields a specific PID without a shell.
const shimPath = "/usr/local/bin/sandbox-exec"

// execDir holds one pidfile per live exec. It is a cancellation handle with the
// lifetime of a single exec call, written and removed by the shim, and must not
// be confused with the stage's own codex.pid, which is the idempotency record.
var execDir = path.Join(work.SandboxRoot, ".exec")

// execTarget is the container one stream addresses. It carries both, because a
// single remoteStreamer serves every sandbox.
type execTarget struct {
	pod       work.SandboxID
	container string
}

// streamOpts is one remote command and the streams it is wired to.
type streamOpts struct {
	argv   []string
	stdin  io.Reader
	stdout io.Writer
	stderr io.Writer
}

// streamer runs one command in a container and reports how it ended.
//
// It is the testability seam of this package and is deliberately unexported: it
// exists so exec, Write and Read are unit-testable without an apiserver, not as
// a second public door. There is no fake pods/exec in client-go — the fake
// clientset has none at all — so everything above this line is tested by
// scripting this interface, and everything below it is integration-only.
type streamer interface {
	stream(ctx context.Context, target execTarget, opts streamOpts) error
}

// remoteStreamer is the remotecommand-backed streamer.
type remoteStreamer struct {
	cfg    *rest.Config
	client rest.Interface
	ns     string
	logger *slog.Logger
}

// newRemoteStreamer builds the streamer that talks to a real apiserver.
func newRemoteStreamer(cfg *rest.Config, client rest.Interface, ns string, logger *slog.Logger) *remoteStreamer {
	return &remoteStreamer{cfg: cfg, client: client, ns: ns, logger: logger}
}

// execOptions decides the exec subresource's parameters, and is the only place
// that does.
//
// TTY is false always: a TTY merges stdout and stderr and muddies the exit
// code, and the exit code is the whole signal a stage's success is read from.
func execOptions(container string, o streamOpts) *corev1.PodExecOptions {
	return &corev1.PodExecOptions{
		Container: container,
		Command:   o.argv,
		Stdin:     o.stdin != nil,
		Stdout:    o.stdout != nil,
		Stderr:    o.stderr != nil,
		TTY:       false,
	}
}

// stream opens the exec subresource and copies the streams until the command
// ends or the context does.
//
// WebSocket first with a SPDY fallback: SPDY is deprecated upstream and the
// WebSocket subprotocol carries the exit status on its own channel, but the
// fallback keeps this working against an apiserver that has not caught up. The
// verbs differ — GET for WebSocket, POST for SPDY — which is why the Role needs
// both get and create on pods/exec.
func (r *remoteStreamer) stream(ctx context.Context, target execTarget, o streamOpts) error {
	req := r.client.Post().
		Resource("pods").
		Namespace(r.ns).
		Name(string(target.pod)).
		SubResource("exec").
		VersionedParams(execOptions(target.container, o), scheme.ParameterCodec)

	ws, err := remotecommand.NewWebSocketExecutor(r.cfg, "GET", req.URL().String())
	if err != nil {
		return fmt.Errorf("building the websocket executor for sandbox %s: %w", target.pod, err)
	}
	spdy, err := remotecommand.NewSPDYExecutor(r.cfg, "POST", req.URL())
	if err != nil {
		return fmt.Errorf("building the spdy executor for sandbox %s: %w", target.pod, err)
	}
	ex, err := remotecommand.NewFallbackExecutor(ws, spdy, func(err error) bool {
		if !httpstream.IsUpgradeFailure(err) {
			return false
		}
		// Worth a line: it means the cluster is still on the deprecated path.
		r.logger.WarnContext(ctx, "sandbox exec fell back to spdy", "sandbox", target.pod, "cause", err.Error())
		return true
	})
	if err != nil {
		return fmt.Errorf("building the fallback executor for sandbox %s: %w", target.pod, err)
	}

	return ex.StreamWithContext(ctx, remotecommand.StreamOptions{
		Stdin:  o.stdin,
		Stdout: o.stdout,
		Stderr: o.stderr,
		Tty:    false,
	})
}

// Exec runs argv in a running sandbox and returns the command's exit code.
//
// A non-zero code is evidence, not an error: the stage failed and the caller
// must report that. A non-nil error means the exec could not be carried out and
// says nothing about the command — in particular the returned code is 0 and
// carries no meaning, and whatever reached stdout is a truncated prefix that
// must not be read as completion.
//
// Cancelling the context kills the remote process, not just this call.
func (s *Sandboxes) Exec(ctx context.Context, sandbox work.SandboxID, argv []string, stdout, stderr io.Writer) (int, error) {
	return s.exec(ctx, sandbox, argv, nil, stdout, stderr)
}

// exec is the one path every remote command takes, so exit-code extraction, the
// kill-on-cancel path and post-failure pod classification each exist once.
func (s *Sandboxes) exec(ctx context.Context, sandbox work.SandboxID, argv []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	if len(argv) == 0 {
		return 0, fmt.Errorf("running a command in sandbox %s: argv is empty: %w", sandbox, work.ErrPermanent)
	}
	if s.streamer == nil {
		return 0, fmt.Errorf("running %v in sandbox %s: this Sandboxes has no exec transport: %w", argv, sandbox, work.ErrPermanent)
	}

	execID := s.nextExecID()
	target := execTarget{pod: sandbox, container: s.opts.containerName}
	// The shim wraps argv rather than replacing it: everything after "--" is
	// handed to the container untouched, which is the argv-only guarantee.
	wrapped := append([]string{shimPath, "--pidfile", pidfilePath(execID), "--"}, argv...)

	// argv0 and argc only: a full argv carries file paths today and could carry
	// more later.
	s.logger.DebugContext(ctx, "sandbox exec started",
		"sandbox", sandbox, "exec_id", execID, "argv0", argv[0], "argc", len(argv))
	started := s.clk.Now()

	err := s.streamer.stream(ctx, target, streamOpts{argv: wrapped, stdin: stdin, stdout: stdout, stderr: stderr})

	if ctxErr := ctx.Err(); ctxErr != nil && err != nil {
		// The caller asked to stop. Kill the remote process rather than merely
		// returning: an activity timeout that leaves codex running burns quota
		// nobody is waiting for.
		s.killExec(ctx, target, execID)
		return 0, fmt.Errorf("running %v in sandbox %s: %w", argv, sandbox, ctxErr)
	}

	code, exited := exitCode(err)
	if err == nil || exited {
		s.logger.InfoContext(ctx, "sandbox exec finished",
			"sandbox", sandbox, "exec_id", execID, "exit_code", code,
			"duration_ms", s.clk.Now().Sub(started).Milliseconds())
		return code, nil
	}
	return 0, s.classifyExecFailure(ctx, sandbox, argv, err)
}

// exitCode reports the command's own exit status, and whether the error is one
// at all.
//
// utilexec.ExitError is an interface, so errors.As matches values that never
// exited — a stream-setup failure among them. Exited() must therefore be
// checked before ExitStatus() is believed, or a transport failure is reported
// as a command that failed, and a healthy stage looks broken.
//
// The reverse direction is also true and is why the default is a non-nil error
// with code 0: remotecommand only produces a CodeExitError when the error
// stream's metav1.Status carries NonZeroExitCode with an ExitCode cause, so
// some genuine command failures arrive as plain errors. Reporting "the exec
// could not be carried out" for one of those is the cheap direction to be wrong
// in — it is retried — whereas a fabricated exit code would be believed.
func exitCode(err error) (int, bool) {
	if err == nil {
		return 0, true
	}
	var exitErr utilexec.ExitError
	if errors.As(err, &exitErr) && exitErr.Exited() {
		// A signal kill arrives here too: the CRI reports it as 128+N, so a
		// SIGKILL — the OOM case — is exit 137 and needs no separate path.
		return exitErr.ExitStatus(), true
	}
	return 0, false
}

// classifyExecFailure decides what a stream failure means, by looking at the
// pod before it looks at the transport error.
//
// Order matters. An activeDeadlineSeconds expiry leaves the pod present in
// phase Failed, and every exec against it then fails with an ordinary transport
// error; classified on the error alone that is retryable, and the stage retries
// into a corpse until its own hour-long timeout.
func (s *Sandboxes) classifyExecFailure(ctx context.Context, sandbox work.SandboxID, argv []string, err error) error {
	op := fmt.Sprintf("running %v", argv)

	pod, getErr := s.cs.CoreV1().Pods(s.ns).Get(ctx, string(sandbox), metav1.GetOptions{})
	switch {
	case apierrors.IsNotFound(getErr):
		return classify(sandbox, op, getErr)
	case getErr != nil:
		// The pod could not be observed, so the transport error is all there is.
		return classify(sandbox, op, err)
	}

	if verdict := classifyPhase(sandbox, op, pod.Status.Phase, pod.Status.Reason, pod.Status.Message); verdict != nil {
		return verdict
	}
	return classify(sandbox, op, err)
}

// killExec asks the shim to kill the process this exec started.
//
// Its outcome is logged and never returned: the caller asked to stop, and a
// failed best-effort kill does not change what exec must report. The context is
// detached because the one it came from is already cancelled — a kill on a dead
// context would not be sent at all — and bounded so a wedged apiserver cannot
// hold a cancelled activity open.
func (s *Sandboxes) killExec(ctx context.Context, target execTarget, execID string) {
	killCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*s.opts.killGrace)
	defer cancel()

	var stderr bytes.Buffer
	err := s.streamer.stream(killCtx, target, streamOpts{
		argv:   []string{shimPath, "--kill", pidfilePath(execID)},
		stderr: &stderr,
	})

	s.logger.WarnContext(killCtx, "killing a cancelled sandbox exec",
		"sandbox", target.pod, "exec_id", execID, "cause", "context_cancelled",
		"error", errText(err), "stderr", stderr.String())
}

// pidfilePath is where the shim records one exec's child PID.
func pidfilePath(execID string) string {
	return path.Join(execDir, execID+".pid")
}

// errText renders an error for a log attribute, including the nil case.
func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
