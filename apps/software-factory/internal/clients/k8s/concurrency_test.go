package k8s

import (
	"context"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"

	"k8s.io/client-go/kubernetes/fake"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codex"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// Sandboxes is the implementation behind three consumer-side interfaces. None
// of them are declared here — interfaces belong to their consumer — so these
// assertions are what keeps the signatures honest.
var (
	_ activities.PodLifecycle = (*Sandboxes)(nil)
	_ codex.PodExecer         = (*Sandboxes)(nil)
	_ codex.FileTransfer      = (*Sandboxes)(nil)
)

// answeringStreamer replies from the command it was given rather than from a
// queue, so a concurrent test's expectations do not depend on call order. A
// shared-state bug therefore shows up as a wrong answer, not only as a race
// report.
type answeringStreamer struct {
	mu    sync.Mutex
	calls int
}

func (f *answeringStreamer) stream(_ context.Context, _ execTarget, o streamOpts) error {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()

	if o.stdin != nil {
		if _, err := io.Copy(io.Discard, o.stdin); err != nil {
			return err
		}
	}
	argv := o.argv
	if argv[0] == "cat" && o.stdout != nil {
		// The payload is derived from the path, so a caller receiving another
		// goroutine's bytes is detectable.
		if _, err := io.WriteString(o.stdout, "payload for "+argv[1]); err != nil {
			return err
		}
	}
	return nil
}

func TestServesConcurrentExecsAndCreatesWithoutADataRace(t *testing.T) {
	t.Parallel()

	str := &answeringStreamer{}
	s, err := newSandboxes(fake.NewSimpleClientset(runningPod()), str, "software-factory", discardLogger(), testClock())
	if err != nil {
		t.Fatalf("newSandboxes returned an unexpected error: %v", err)
	}

	const workers = 8
	const rounds = 12
	errs := make(chan error, workers*rounds*3)

	var wg sync.WaitGroup
	for w := range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for r := range rounds {
				path := fmt.Sprintf("%s/run/%d-%d/result.json", work.SandboxRoot, w, r)

				got, err := s.Read(context.Background(), testSandbox, path)
				switch {
				case err != nil:
					errs <- fmt.Errorf("Read(%s): %w", path, err)
				case string(got) != "payload for "+path:
					errs <- fmt.Errorf("Read(%s) = %q, want the payload for its own path", path, got)
				}

				if err := s.Write(context.Background(), testSandbox, path, []byte("x"), 0o600); err != nil {
					errs <- fmt.Errorf("Write(%s): %w", path, err)
				}

				if _, err := s.Exec(context.Background(), testSandbox, []string{"true"}, nil, io.Discard, io.Discard); err != nil {
					errs <- fmt.Errorf("Exec: %w", err)
				}

				spec := validSpec()
				spec.TicketNumber = w*100 + r + 1
				if _, err := s.Create(context.Background(), spec); err != nil {
					errs <- fmt.Errorf("Create(ticket %d): %w", spec.TicketNumber, err)
				}
			}
		}()
	}
	wg.Wait()
	close(errs)

	var failures []string
	for err := range errs {
		failures = append(failures, err.Error())
	}
	if len(failures) > 0 {
		t.Fatalf("%d concurrent operations returned the wrong answer:\n%s", len(failures), strings.Join(failures, "\n"))
	}
}
