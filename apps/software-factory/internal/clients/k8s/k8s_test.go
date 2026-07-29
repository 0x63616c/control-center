package k8s

import (
	"io"
	"log/slog"
	"testing"
	"time"

	"k8s.io/client-go/kubernetes/fake"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock/clocktest"
)

func discardLogger() *slog.Logger { return slog.New(slog.NewJSONHandler(io.Discard, nil)) }

func testClock() *clocktest.Fake {
	return clocktest.NewFake(time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC))
}

func TestRefusesToConstructWithoutTheThingsItCannotWorkWithout(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name      string
		namespace string
		logger    *slog.Logger
		clk       clock.Clock
		opts      []Option
	}{
		{name: "without a namespace", logger: discardLogger(), clk: testClock()},
		{name: "without a logger", namespace: "software-factory", clk: testClock()},
		{name: "without a clock", namespace: "software-factory", logger: discardLogger()},
		{
			name: "without a positive read limit", namespace: "software-factory",
			logger: discardLogger(), clk: testClock(), opts: []Option{WithMaxReadBytes(0)},
		},
		{
			name: "with a container name that is not a valid kubernetes name", namespace: "software-factory",
			logger: discardLogger(), clk: testClock(), opts: []Option{WithContainerName("Not A Name")},
		},
		{
			name: "with a kill grace that is not positive", namespace: "software-factory",
			logger: discardLogger(), clk: testClock(), opts: []Option{WithKillGrace(0)},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := newSandboxes(fake.NewSimpleClientset(), nil, tc.namespace, tc.logger, tc.clk, tc.opts...)
			if err == nil {
				t.Fatalf("newSandboxes succeeded %s; there is no usable-but-invalid Sandboxes", tc.name)
			}
			if got != nil {
				t.Error("newSandboxes returned a value alongside its error")
			}
		})
	}
}

func TestConstructsWithEverythingItNeeds(t *testing.T) {
	t.Parallel()

	got, err := newSandboxes(fake.NewSimpleClientset(), nil, "software-factory", discardLogger(), testClock())
	if err != nil {
		t.Fatalf("newSandboxes returned an unexpected error: %v", err)
	}
	if got == nil {
		t.Fatal("newSandboxes returned nil without an error")
	}
}

func TestNewInClusterValidatesItsArgumentsBeforeReachingForACluster(t *testing.T) {
	t.Parallel()

	// There is no cluster here, so a constructor that dialled first would fail
	// with a confusing "unable to load in-cluster configuration" for what is
	// really a programmer error.
	if _, err := NewInCluster("", discardLogger(), testClock()); err == nil {
		t.Fatal("NewInCluster accepted an empty namespace")
	}
	if _, err := NewInCluster("software-factory", nil, testClock()); err == nil {
		t.Fatal("NewInCluster accepted a nil logger")
	}
}

func TestMintsADistinctTagForEveryExec(t *testing.T) {
	t.Parallel()

	s, err := newSandboxes(fake.NewSimpleClientset(), nil, "software-factory", discardLogger(), testClock())
	if err != nil {
		t.Fatalf("newSandboxes returned an unexpected error: %v", err)
	}

	// The tag names a pidfile, and two live execs sharing one would have the
	// second's cancellation kill the first's process.
	seen := make(map[string]bool, 128)
	for range 128 {
		id := s.nextExecID()
		if seen[id] {
			t.Fatalf("exec id %q was minted twice", id)
		}
		seen[id] = true
	}
}
