package k8s

import (
	"fmt"
	"log/slog"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
)

// RunWorkers is the target-only Kubernetes capability. Unlike Sandboxes it
// deliberately has no exec, clone, or remote file-transfer surface.
type RunWorkers struct {
	cs     kubernetes.Interface
	ns     string
	logger *slog.Logger
	clk    clock.Clock
	opts   options
}

// NewRunWorkersInCluster binds target worker lifecycle to one namespace.
func NewRunWorkersInCluster(namespace string, logger *slog.Logger, clk clock.Clock, opts ...Option) (*RunWorkers, error) {
	o, err := resolveRunWorkerOptions(opts)
	if err != nil {
		return nil, err
	}
	if err := validateRunWorkerDeps(namespace, logger, clk); err != nil {
		return nil, err
	}
	cfg, err := rest.InClusterConfig()
	if err != nil {
		return nil, fmt.Errorf("reading in-cluster Kubernetes configuration for Run Workers: %w", err)
	}
	cfg.Timeout = apiTimeout
	cfg.WarningHandlerWithContext = warningLogger{logger: logger}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("building the Run Worker Kubernetes client: %w", err)
	}
	return &RunWorkers{cs: cs, ns: namespace, logger: logger, clk: clk, opts: o}, nil
}

func newRunWorkers(cs kubernetes.Interface, namespace string, logger *slog.Logger, clk clock.Clock, opts ...Option) (*RunWorkers, error) {
	o, err := resolveRunWorkerOptions(opts)
	if err != nil {
		return nil, err
	}
	if err := validateRunWorkerDeps(namespace, logger, clk); err != nil {
		return nil, err
	}
	if cs == nil {
		return nil, fmt.Errorf("constructing RunWorkers: the clientset is nil")
	}
	return &RunWorkers{cs: cs, ns: namespace, logger: logger, clk: clk, opts: o}, nil
}

func resolveRunWorkerOptions(opts []Option) (options, error) {
	o := defaultOptions()
	o.containerName = "run-worker"
	for _, opt := range opts {
		if opt == nil {
			return options{}, fmt.Errorf("constructing RunWorkers: a nil Option was supplied")
		}
		opt(&o)
	}
	if o.maxReadBytes <= 0 {
		return options{}, fmt.Errorf("constructing RunWorkers: the read limit must be positive")
	}
	if problems := validation.IsDNS1123Label(o.containerName); len(problems) > 0 {
		return options{}, fmt.Errorf("constructing RunWorkers: container name %q is invalid: %s", o.containerName, problems[0])
	}
	if o.imagePullSecretName != "" {
		if problems := validation.IsDNS1123Subdomain(o.imagePullSecretName); len(problems) > 0 {
			return options{}, fmt.Errorf("constructing RunWorkers: image pull secret %q is invalid: %s", o.imagePullSecretName, problems[0])
		}
	}
	return o, nil
}

func validateRunWorkerDeps(namespace string, logger *slog.Logger, clk clock.Clock) error {
	if problems := validation.IsDNS1123Label(namespace); namespace == "" || len(problems) > 0 {
		return fmt.Errorf("constructing RunWorkers: namespace %q is invalid", namespace)
	}
	if logger == nil {
		return fmt.Errorf("constructing RunWorkers: a logger is required")
	}
	if clk == nil {
		return fmt.Errorf("constructing RunWorkers: a clock is required")
	}
	return nil
}

func ignoreAbsent(err error) error {
	if err == nil || apierrors.IsNotFound(err) {
		return nil
	}
	return err
}
