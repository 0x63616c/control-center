// Package k8s is the only place this service speaks to the Kubernetes API. It
// seals client-go, its pod types and its exec streaming behind the sandbox
// vocabulary in internal/work, so nothing else in the service has to hold a
// Kubernetes worldview to create a sandbox, run a command in one, or throw it
// away.
//
// The seal is mechanical: .golangci.yml denies k8s.io imports everywhere under
// internal/ except this directory. That is why no signature here names a
// Kubernetes type, and why a test elsewhere fakes one of the three interfaces
// this satisfies rather than a clientset.
package k8s

import (
	"context"
	"fmt"
	"log/slog"
	"sync/atomic"

	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
)

// Sandboxes creates, execs into and destroys per-ticket sandbox pods in one
// namespace. It satisfies activities.PodLifecycle and codex.PodExecer /
// codex.FileTransfer; it declares none of them, because interfaces are
// consumer-side.
//
// It is safe for concurrent use. It holds immutable configuration, a clientset
// which is itself concurrency-safe, and one atomic counter; no method mutates
// the receiver otherwise, and nothing here touches process-global state.
type Sandboxes struct {
	cs       kubernetes.Interface
	streamer streamer
	ns       string
	logger   *slog.Logger
	clk      clock.Clock
	opts     options

	// execSeq distinguishes two execs minted in the same nanosecond. The tag it
	// contributes to names a pidfile, and two live execs sharing one would have
	// the second's cancellation kill the first's process.
	execSeq atomic.Uint64
}

// NewInCluster builds a Sandboxes from the pod's own service account.
//
// It takes the namespace rather than reading one: config is read in exactly one
// place, and this is not it. It builds its own rest.Config so that no caller
// has to name a client-go type to construct this — cmd/ sits outside the
// depguard wall, so the seal there is held by the signature, not the linter.
func NewInCluster(namespace string, logger *slog.Logger, clk clock.Clock, opts ...Option) (*Sandboxes, error) {
	// Validate before dialling, so a programmer error reads as one instead of
	// as "unable to load in-cluster configuration".
	o, err := resolveOptions(opts)
	if err != nil {
		return nil, err
	}
	if err := validateDeps(namespace, logger, clk); err != nil {
		return nil, err
	}

	cfg, err := rest.InClusterConfig()
	if err != nil {
		return nil, fmt.Errorf("reading the in-cluster Kubernetes configuration: %w", err)
	}
	// Deprecation warnings from the apiserver become structured records on this
	// client's logger rather than unstructured lines on stderr. This is
	// per-instance; the klog bridge that catches client-go's own logging is
	// process-global and belongs to cmd/worker.
	cfg.WarningHandlerWithContext = warningLogger{logger: logger}

	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("building the Kubernetes client: %w", err)
	}

	s := &Sandboxes{
		cs:       cs,
		streamer: newRemoteStreamer(cfg, cs.CoreV1().RESTClient(), namespace, logger),
		ns:       namespace,
		logger:   logger,
		clk:      clk,
		opts:     o,
	}
	return s, nil
}

// newSandboxes is the constructor tests use: it takes the clientset and the
// exec seam directly, so no unit test needs an apiserver.
func newSandboxes(cs kubernetes.Interface, str streamer, namespace string, logger *slog.Logger, clk clock.Clock, opts ...Option) (*Sandboxes, error) {
	o, err := resolveOptions(opts)
	if err != nil {
		return nil, err
	}
	if err := validateDeps(namespace, logger, clk); err != nil {
		return nil, err
	}
	if cs == nil {
		return nil, fmt.Errorf("constructing a Sandboxes: the clientset is nil")
	}
	return &Sandboxes{cs: cs, streamer: str, ns: namespace, logger: logger, clk: clk, opts: o}, nil
}

// resolveOptions applies the options over the defaults and validates once.
func resolveOptions(opts []Option) (options, error) {
	o := defaultOptions()
	for _, opt := range opts {
		if opt == nil {
			return options{}, fmt.Errorf("constructing a Sandboxes: a nil Option was supplied")
		}
		opt(&o)
	}
	if o.maxReadBytes <= 0 {
		return options{}, fmt.Errorf("constructing a Sandboxes: the read limit is %d bytes, which no file satisfies", o.maxReadBytes)
	}
	if problems := validation.IsDNS1123Label(o.containerName); len(problems) > 0 {
		return options{}, fmt.Errorf("constructing a Sandboxes: container name %q is not a valid Kubernetes name: %s", o.containerName, problems[0])
	}
	if o.killGrace <= 0 {
		return options{}, fmt.Errorf("constructing a Sandboxes: the kill grace is %s, leaving no window between SIGTERM and SIGKILL", o.killGrace)
	}
	return o, nil
}

// validateDeps rejects the required dependencies this cannot work without.
func validateDeps(namespace string, logger *slog.Logger, clk clock.Clock) error {
	if namespace == "" {
		return fmt.Errorf("constructing a Sandboxes: the namespace is empty, and a sandbox must be bound to one")
	}
	if problems := validation.IsDNS1123Label(namespace); len(problems) > 0 {
		return fmt.Errorf("constructing a Sandboxes: namespace %q is not a valid Kubernetes name: %s", namespace, problems[0])
	}
	if logger == nil {
		return fmt.Errorf("constructing a Sandboxes: the logger is nil, and this package logs its own decisions")
	}
	if clk == nil {
		return fmt.Errorf("constructing a Sandboxes: the clock is nil")
	}
	return nil
}

// nextExecID mints the tag one exec is known by, which names its pidfile.
//
// It is a counter and a timestamp rather than random bytes: uniqueness is only
// needed among the execs live in one sandbox at one time, and crypto/rand is
// denied outside the composition root.
func (s *Sandboxes) nextExecID() string {
	return fmt.Sprintf("%d-%d", s.clk.Now().UnixNano(), s.execSeq.Add(1))
}

// warningLogger turns an apiserver deprecation warning into a structured
// record. Unhandled, these go to stderr unstructured and Loki never sees them.
type warningLogger struct{ logger *slog.Logger }

// HandleWarningHeaderWithContext records one warning header.
func (w warningLogger) HandleWarningHeaderWithContext(ctx context.Context, code int, agent, text string) {
	if code != 299 || text == "" {
		return
	}
	w.logger.WarnContext(ctx, "kubernetes apiserver warning", "agent", agent, "warning", text)
}
