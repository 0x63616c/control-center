package transcripts

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// newSink builds a Sink over a fresh temporary root, which every test here
// treats as the transcript volume's mount point.
func newSink(t *testing.T) (*Sink, string) {
	t.Helper()
	root := t.TempDir()
	s, err := New(root)
	if err != nil {
		t.Fatalf("New returned an unexpected error: %v", err)
	}
	return s, root
}

// writeEvents opens the key's transcript, writes each line, and closes it.
func writeEvents(t *testing.T, s *Sink, key work.StageKey, lines ...string) {
	t.Helper()
	w, err := s.Open(context.Background(), key)
	if err != nil {
		t.Fatalf("Open(%s) returned an unexpected error: %v", key, err)
	}
	for _, line := range lines {
		if _, err := io.WriteString(w, line); err != nil {
			t.Fatalf("writing %q returned an unexpected error: %v", line, err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close returned an unexpected error: %v", err)
	}
}

// openCount reports how many transcripts the sink currently holds open. It
// lives here rather than on Sink so the refcount stays private to the package.
func openCount(s *Sink) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.open)
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s returned an unexpected error: %v", path, err)
	}
	return string(b)
}

func TestSinkWritesAStagesEventsUnderThePathTheStageKeyNames(t *testing.T) {
	t.Parallel()

	s, root := newSink(t)
	key := work.StageKey{Ticket: 312, RunID: "0198c2f1", Stage: work.StageReview}
	writeEvents(t, s, key, "{\"a\":1}\n", "{\"a\":2}\n")

	got := readFile(t, filepath.Join(root, "312", "0198c2f1", "review.jsonl"))
	if want := "{\"a\":1}\n{\"a\":2}\n"; got != want {
		t.Errorf("transcript = %q, want %q", got, want)
	}
}

func TestSinkCreatesTheTicketAndRunDirectoriesThatDoNotExistYet(t *testing.T) {
	t.Parallel()

	s, root := newSink(t)
	key := work.StageKey{Ticket: 7, RunID: "0198c2f1", Stage: work.StagePlan}
	writeEvents(t, s, key, "{}\n")

	info, err := os.Stat(filepath.Join(root, "7", "0198c2f1"))
	if err != nil {
		t.Fatalf("the run directory was not created: %v", err)
	}
	if !info.IsDir() {
		t.Errorf("the run directory is not a directory")
	}
}

func TestSinkLeavesAnEmptyTranscriptWhenAStageEmitsNothing(t *testing.T) {
	t.Parallel()

	s, root := newSink(t)
	key := work.StageKey{Ticket: 7, RunID: "0198c2f1", Stage: work.StagePlan}
	writeEvents(t, s, key)

	info, err := os.Stat(filepath.Join(root, "7", "0198c2f1", "plan.jsonl"))
	if err != nil {
		t.Fatalf("a stage that emitted nothing left no transcript: %v", err)
	}
	if info.Size() != 0 {
		t.Errorf("transcript size = %d bytes, want 0", info.Size())
	}
}

func TestSinkAppendsToAnExistingTranscriptRatherThanTruncatingIt(t *testing.T) {
	t.Parallel()

	s, root := newSink(t)
	key := work.StageKey{Ticket: 7, RunID: "0198c2f1", Stage: work.StageImplement}
	writeEvents(t, s, key, "first\n")
	writeEvents(t, s, key, "second\n")

	got := readFile(t, filepath.Join(root, "7", "0198c2f1", "implement.jsonl"))
	if want := "first\nsecond\n"; got != want {
		t.Errorf("transcript = %q, want %q — a retry must not erase the attempt it replaced", got, want)
	}
}

func TestSinkLetsAReaderTailATranscriptBeforeTheStageFinishes(t *testing.T) {
	t.Parallel()

	s, root := newSink(t)
	key := work.StageKey{Ticket: 7, RunID: "0198c2f1", Stage: work.StageImplement}
	w, err := s.Open(context.Background(), key)
	if err != nil {
		t.Fatalf("Open returned an unexpected error: %v", err)
	}
	defer func() {
		if err := w.Close(); err != nil {
			t.Errorf("Close returned an unexpected error: %v", err)
		}
	}()

	if _, err := io.WriteString(w, "mid-stage\n"); err != nil {
		t.Fatalf("writing returned an unexpected error: %v", err)
	}

	got := readFile(t, filepath.Join(root, "7", "0198c2f1", "implement.jsonl"))
	if want := "mid-stage\n"; got != want {
		t.Errorf("transcript = %q, want %q — events must reach the volume before the stage ends", got, want)
	}
}

func TestSinkKeepsTwoRunsOfTheSameStageSeparatelyInspectable(t *testing.T) {
	t.Parallel()

	s, root := newSink(t)
	first := work.StageKey{Ticket: 7, RunID: "0198c2f1", Stage: work.StagePlan}
	second := work.StageKey{Ticket: 7, RunID: "0198c2f2", Stage: work.StagePlan}
	writeEvents(t, s, first, "from the first run\n")
	writeEvents(t, s, second, "from the second run\n")

	if got, want := readFile(t, filepath.Join(root, "7", "0198c2f1", "plan.jsonl")), "from the first run\n"; got != want {
		t.Errorf("first run's transcript = %q, want %q", got, want)
	}
	if got, want := readFile(t, filepath.Join(root, "7", "0198c2f2", "plan.jsonl")), "from the second run\n"; got != want {
		t.Errorf("second run's transcript = %q, want %q", got, want)
	}
}

func TestSinkOpensTranscriptsForManyStagesOfOneRunConcurrently(t *testing.T) {
	t.Parallel()

	s, root := newSink(t)
	stages := work.Pipeline()

	var wg sync.WaitGroup
	start := make(chan struct{})
	for _, stage := range stages {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			key := work.StageKey{Ticket: 7, RunID: "0198c2f1", Stage: stage}
			w, err := s.Open(context.Background(), key)
			if err != nil {
				t.Errorf("Open(%s) returned an unexpected error: %v", key, err)
				return
			}
			if _, err := io.WriteString(w, string(stage)+"\n"); err != nil {
				t.Errorf("writing for %s returned an unexpected error: %v", key, err)
			}
			if err := w.Close(); err != nil {
				t.Errorf("Close for %s returned an unexpected error: %v", key, err)
			}
		}()
	}
	close(start)
	wg.Wait()

	for _, stage := range stages {
		path := filepath.Join(root, "7", "0198c2f1", string(stage)+".jsonl")
		if got, want := readFile(t, path), string(stage)+"\n"; got != want {
			t.Errorf("%s transcript = %q, want %q", stage, got, want)
		}
	}
}

func TestSinkInterleavesTwoOverlappingAttemptsOfOneStageWithoutLosingALine(t *testing.T) {
	t.Parallel()

	const attempts, linesPerAttempt = 2, 200

	s, root := newSink(t)
	key := work.StageKey{Ticket: 7, RunID: "0198c2f1", Stage: work.StageImplement}

	var wg sync.WaitGroup
	start := make(chan struct{})
	for attempt := range attempts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w, err := s.Open(context.Background(), key)
			if err != nil {
				t.Errorf("Open returned an unexpected error: %v", err)
				return
			}
			<-start
			for i := range linesPerAttempt {
				if _, err := io.WriteString(w, fmt.Sprintf("attempt %d line %d\n", attempt, i)); err != nil {
					t.Errorf("writing returned an unexpected error: %v", err)
				}
			}
			if err := w.Close(); err != nil {
				t.Errorf("Close returned an unexpected error: %v", err)
			}
		}()
	}
	close(start)
	wg.Wait()

	got := strings.Split(strings.TrimSuffix(readFile(t, filepath.Join(root, "7", "0198c2f1", "implement.jsonl")), "\n"), "\n")
	want := make([]string, 0, attempts*linesPerAttempt)
	for attempt := range attempts {
		for i := range linesPerAttempt {
			want = append(want, fmt.Sprintf("attempt %d line %d", attempt, i))
		}
	}
	// Ordering across the two attempts is wall-clock, so only the multiset is
	// asserted: every line whole, every line present.
	sort.Strings(got)
	sort.Strings(want)
	if len(got) != len(want) {
		t.Fatalf("transcript holds %d lines, want %d — an overlapping attempt lost or corrupted output", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("line %d = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestSinkSharesOneDescriptorBetweenOverlappingAttemptsOfOneStage(t *testing.T) {
	t.Parallel()

	// A temp filesystem makes independent O_APPEND writes atomic, so the byte
	// loss this design prevents cannot be reproduced here. What is observable is
	// the mechanism that prevents it: one descriptor, refcounted.
	s, root := newSink(t)
	key := work.StageKey{Ticket: 7, RunID: "0198c2f1", Stage: work.StageImplement}

	first, err := s.Open(context.Background(), key)
	if err != nil {
		t.Fatalf("Open returned an unexpected error: %v", err)
	}
	second, err := s.Open(context.Background(), key)
	if err != nil {
		t.Fatalf("the second Open returned an unexpected error: %v", err)
	}
	if got := openCount(s); got != 1 {
		t.Errorf("the sink holds %d open transcripts, want 1 — overlapping attempts must share a descriptor", got)
	}

	if err := first.Close(); err != nil {
		t.Fatalf("closing the first attempt returned an unexpected error: %v", err)
	}
	if _, err := io.WriteString(second, "after the first attempt closed\n"); err != nil {
		t.Fatalf("the surviving attempt could not write: %v", err)
	}
	if err := second.Close(); err != nil {
		t.Fatalf("closing the second attempt returned an unexpected error: %v", err)
	}
	if got := openCount(s); got != 0 {
		t.Errorf("the sink holds %d open transcripts after every attempt closed, want 0", got)
	}
	if got, want := readFile(t, filepath.Join(root, "7", "0198c2f1", "implement.jsonl")), "after the first attempt closed\n"; got != want {
		t.Errorf("transcript = %q, want %q", got, want)
	}
}

func TestSinkToleratesASecondCloseOfTheSameTranscript(t *testing.T) {
	t.Parallel()

	s, _ := newSink(t)
	key := work.StageKey{Ticket: 7, RunID: "0198c2f1", Stage: work.StagePlan}

	shared, err := s.Open(context.Background(), key)
	if err != nil {
		t.Fatalf("Open returned an unexpected error: %v", err)
	}
	w, err := s.Open(context.Background(), key)
	if err != nil {
		t.Fatalf("the second Open returned an unexpected error: %v", err)
	}

	if err := w.Close(); err != nil {
		t.Fatalf("Close returned an unexpected error: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Errorf("the second Close returned %v, want nil", err)
	}
	// A repeated Close must not drop someone else's reference.
	if _, err := io.WriteString(shared, "still open\n"); err != nil {
		t.Errorf("a concurrent holder lost its descriptor to a repeated Close: %v", err)
	}
	if err := shared.Close(); err != nil {
		t.Errorf("Close returned an unexpected error: %v", err)
	}
}

func TestNewRefusesARootThatIsNotADirectory(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatalf("preparing the fixture failed: %v", err)
	}
	if _, err := New(path); err == nil {
		t.Error("New accepted a regular file as the transcript root")
	}
}

func TestNewRefusesARootThatDoesNotExist(t *testing.T) {
	t.Parallel()

	if _, err := New(filepath.Join(t.TempDir(), "absent")); err == nil {
		t.Error("New accepted a transcript root that does not exist")
	}
}

func TestSinkRefusesAStageKeyThatCannotNameATranscript(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		key  work.StageKey
	}{
		{name: "no run id", key: work.StageKey{Ticket: 7, Stage: work.StagePlan}},
		{name: "no stage", key: work.StageKey{Ticket: 7, RunID: "0198c2f1"}},
		{name: "no ticket", key: work.StageKey{RunID: "0198c2f1", Stage: work.StagePlan}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			s, _ := newSink(t)
			if _, err := s.Open(context.Background(), tc.key); !errors.Is(err, ErrInvalidKey) {
				t.Errorf("Open error = %v, want it to wrap ErrInvalidKey", err)
			}
		})
	}
}

func TestSinkReportsWhichStageItCouldNotOpenATranscriptFor(t *testing.T) {
	t.Parallel()

	if os.Getuid() == 0 {
		t.Skip("root ignores directory permissions, so the failure cannot be provoked")
	}

	// Chmod a subdirectory the test made rather than t.TempDir itself, so its
	// RemoveAll cleanup still succeeds.
	root := filepath.Join(t.TempDir(), "read-only")
	if err := os.Mkdir(root, 0o750); err != nil {
		t.Fatalf("preparing the fixture failed: %v", err)
	}
	if err := os.Chmod(root, 0o500); err != nil {
		t.Fatalf("preparing the fixture failed: %v", err)
	}
	t.Cleanup(func() {
		if err := os.Chmod(root, 0o750); err != nil {
			t.Errorf("restoring the fixture's mode failed: %v", err)
		}
	})

	s, err := New(root)
	if err != nil {
		t.Fatalf("New returned an unexpected error: %v", err)
	}
	key := work.StageKey{Ticket: 312, RunID: "0198c2f1", Stage: work.StageReview}
	_, err = s.Open(context.Background(), key)
	if err == nil {
		t.Fatal("Open succeeded against a root it cannot write to")
	}
	if !strings.Contains(err.Error(), key.String()) {
		t.Errorf("Open error = %q, want it to name %q", err, key)
	}
}
