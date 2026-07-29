package codex

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock/clocktest"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

const resultJSON = `{"document":"the plan"}`

func TestAStageWritesItsPromptAndSchemaIntoTheSandbox(t *testing.T) {
	t.Parallel()

	pods, files := newFakes()
	pods.onCodex = writesResult(files, resultJSON, `{"type":"thread.started","thread_id":"thr_1"}`)

	if _, err := newTestRunner(pods, files).RunStage(context.Background(), testRun(), func([]byte) {}); err != nil {
		t.Fatalf("RunStage() = %v", err)
	}

	paths := testRun().Key.Paths()
	if got := string(files.content(paths.Prompt)); got != testRun().Prompt {
		t.Errorf("the prompt file holds %q, want the rendered prompt", got)
	}
	if got := string(files.content(paths.Schema)); got != string(testRun().Schema) {
		t.Errorf("the schema file holds %q, want the stage's schema", got)
	}
}

func TestThePromptReachesCodexOnStdin(t *testing.T) {
	t.Parallel()

	// codex reads its instructions from stdin when given no positional prompt.
	// This is the other half of the argv-only guarantee: the prompt has to
	// arrive somehow, and every other route makes issue text an argument.
	pods, files := newFakes()
	pods.onCodex = writesResult(files, resultJSON)

	if _, err := newTestRunner(pods, files).RunStage(context.Background(), testRun(), func([]byte) {}); err != nil {
		t.Fatalf("RunStage() = %v", err)
	}

	call := pods.codexCall(t)
	if call.stdin != testRun().Prompt {
		t.Errorf("codex received %q on stdin, want the rendered prompt", call.stdin)
	}
	if slices.ContainsFunc(call.argv, func(arg string) bool { return strings.Contains(arg, "plan this ticket") }) {
		t.Errorf("the prompt reached argv: %q", call.argv)
	}
}

func TestAStageReturnsItsResultUsageAndThreadID(t *testing.T) {
	t.Parallel()

	pods, files := newFakes()
	pods.onCodex = writesResult(files, resultJSON,
		`{"type":"thread.started","thread_id":"thr_abc"}`,
		`{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":20,"reasoning_output_tokens":5}}`,
	)

	result, err := newTestRunner(pods, files).RunStage(context.Background(), testRun(), func([]byte) {})
	if err != nil {
		t.Fatalf("RunStage() = %v", err)
	}

	if string(result.Output) != resultJSON {
		t.Errorf("Output = %q, want the result file's bytes unparsed", result.Output)
	}
	if result.ThreadID != "thr_abc" {
		t.Errorf("ThreadID = %q, want thr_abc", result.ThreadID)
	}
	want := work.Usage{InputTokens: 100, CachedInputTokens: 40, OutputTokens: 20, ReasoningTokens: 5}
	if result.Usage != want {
		t.Errorf("Usage = %+v, want %+v carried verbatim", result.Usage, want)
	}
}

func TestEveryEventReachesTheSinkWhileTheStageRuns(t *testing.T) {
	t.Parallel()

	// The sink is the transcript and the activity's heartbeat. A stage that
	// emitted nothing for the heartbeat timeout is treated as dead, so events
	// buffered until the end would fail a stage that was working.
	pods, files := newFakes()
	pods.onCodex = writesResult(files, resultJSON,
		`{"type":"thread.started","thread_id":"thr_1"}`,
		`{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}`,
	)

	var mu sync.Mutex
	var seen int
	if _, err := newTestRunner(pods, files).RunStage(context.Background(), testRun(), func([]byte) {
		mu.Lock()
		defer mu.Unlock()
		seen++
	}); err != nil {
		t.Fatalf("RunStage() = %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if seen != 2 {
		t.Errorf("the sink saw %d events, want 2", seen)
	}
}

func TestAFailedStageReportsWhyAndReturnsNoResult(t *testing.T) {
	t.Parallel()

	// The empty-stdout case end to end: codex exits 1 having written only to
	// stderr, which is what a spent refresh token looks like.
	pods, files := newFakes()
	pods.onCodex = func(c *execCall) (int, error) {
		if _, err := fmt.Fprint(c.stderr, "ERROR: Your session has expired. Please run `codex login`."); err != nil {
			return 0, err
		}
		return 1, nil
	}

	_, err := newTestRunner(pods, files).RunStage(context.Background(), testRun(), func([]byte) {})
	if err == nil {
		t.Fatal("RunStage() = nil error for a stage that exited 1")
	}
	if !errors.Is(err, ErrAuth) || !errors.Is(err, work.ErrPermanent) {
		t.Errorf("RunStage() = %v, want a permanent auth failure", err)
	}
	if !strings.Contains(err.Error(), "session has expired") {
		t.Errorf("RunStage() = %v, want the stderr cause", err)
	}
}

func TestAStageThatExitsCleanlyWithoutWritingAResultIsAFailure(t *testing.T) {
	t.Parallel()

	// The result file is the stage's whole output. Exiting 0 without one means
	// the model answered outside its schema, and carrying that forward would
	// hand the next stage an empty document as though it were a plan.
	pods, files := newFakes()
	pods.onCodex = func(*execCall) (int, error) { return 0, nil }

	if _, err := newTestRunner(pods, files).RunStage(context.Background(), testRun(), func([]byte) {}); err == nil {
		t.Error("RunStage() = nil error for a stage that wrote no result")
	}
}

func TestAFinishedStageIsReadRatherThanRerun(t *testing.T) {
	t.Parallel()

	// Activities retry. A retry that re-ran a completed stage would pay for the
	// same model invocation twice out of a subscription window the owner also
	// uses interactively.
	pods, files := newFakes()
	files.put(testRun().Key.Paths().Result, []byte(resultJSON))

	result, err := newTestRunner(pods, files).RunStage(context.Background(), testRun(), func([]byte) {})
	if err != nil {
		t.Fatalf("RunStage() = %v", err)
	}
	if string(result.Output) != resultJSON {
		t.Errorf("Output = %q, want the stored result", result.Output)
	}
	if pods.codexCalls() != 0 {
		t.Errorf("codex was invoked %d times for an already-finished stage", pods.codexCalls())
	}
}

func TestAResumedStageDoesNotInventTokensItDidNotSee(t *testing.T) {
	t.Parallel()

	// The stream that carried the usage and thread id belonged to a process
	// this attempt was never attached to, so both are genuinely unknown. A
	// fabricated number would be worse than under-reporting, because nothing
	// downstream could tell it from a measurement — and a bare zero has that
	// same problem, since zero tokens is a legitimate reading. UsageMeasured is
	// what separates the two, so it is asserted here rather than left to the
	// WARN log, which only a human sees.
	pods, files := newFakes()
	files.put(testRun().Key.Paths().Result, []byte(resultJSON))

	result, err := newTestRunner(pods, files).RunStage(context.Background(), testRun(), func([]byte) {})
	if err != nil {
		t.Fatalf("RunStage() = %v", err)
	}
	if result.Usage != (work.Usage{}) || result.ThreadID != "" {
		t.Errorf("a resumed stage reported Usage %+v and ThreadID %q, want both empty", result.Usage, result.ThreadID)
	}
	if result.UsageMeasured {
		t.Error("a resumed stage claims its zero usage was measured; an aggregator would add it to a total as though nobody had spent anything")
	}
}

func TestAStageThatRanReportsItsUsageAsMeasured(t *testing.T) {
	t.Parallel()

	// The other half of the same fact. If UsageMeasured were never set, every
	// stage would look unmeasured and the flag would say nothing at all.
	pods, files := newFakes()
	pods.onCodex = func(call *execCall) (int, error) {
		files.put(testRun().Key.Paths().Result, []byte(resultJSON))
		_, err := io.WriteString(call.stdout, `{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":20,"reasoning_output_tokens":5}}`+"\n")
		return 0, err
	}

	result, err := newTestRunner(pods, files).RunStage(context.Background(), testRun(), func([]byte) {})
	if err != nil {
		t.Fatalf("RunStage() = %v", err)
	}
	if !result.UsageMeasured {
		t.Error("a stage this worker watched run reports its usage as unmeasured")
	}
}

// pgrep exiting 0 IS the liveness answer, whatever it printed. procps prints a
// PID line, but it can also print a warning, and a build that printed nothing
// would still be saying "I matched something". Reading the number rather than
// the exit code turns any of those into "no attempt is running" and starts a
// second codex against the live one — two models writing the same result file,
// paid for twice, with nothing in the logs to say it happened.
func TestAnExitZeroPgrepThatPrintsNoUsablePIDIsStillALiveAttempt(t *testing.T) {
	t.Parallel()

	for _, out := range []string{"", "\n", "pgrep: some warning\n"} {
		t.Run(fmt.Sprintf("%q", out), func(t *testing.T) {
			t.Parallel()

			pods, files := newFakes()
			pods.aliveOutput = &out
			pods.onPgrepPoll = func(calls int) {
				if calls == 2 {
					files.put(testRun().Key.Paths().Result, []byte(resultJSON))
				}
			}

			result, err := newTestRunner(pods, files).RunStage(context.Background(), testRun(), func([]byte) {})
			if err != nil {
				t.Fatalf("RunStage() = %v", err)
			}
			if pods.codexCalls() != 0 {
				t.Errorf("codex was invoked %d times against a sandbox where pgrep said one was already running", pods.codexCalls())
			}
			if string(result.Output) != resultJSON {
				t.Errorf("Output = %q, want the attached attempt's result", result.Output)
			}
		})
	}
}

func TestALiveAttemptIsWaitedForRatherThanDuplicated(t *testing.T) {
	t.Parallel()

	// A retry can begin while the previous attempt's codex is still running in
	// the sandbox. Starting a second one against the same sandbox would have
	// two models writing the same files, and pay twice for it.
	pods, files := newFakes()
	pods.alivePID = 4321
	pods.onPgrepPoll = func(calls int) {
		if calls == 2 {
			files.put(testRun().Key.Paths().Result, []byte(resultJSON))
		}
	}

	result, err := newTestRunner(pods, files).RunStage(context.Background(), testRun(), func([]byte) {})
	if err != nil {
		t.Fatalf("RunStage() = %v", err)
	}
	if pods.codexCalls() != 0 {
		t.Errorf("codex was invoked %d times while an attempt was already live", pods.codexCalls())
	}
	if string(result.Output) != resultJSON {
		t.Errorf("Output = %q, want the attached attempt's result", result.Output)
	}
}

func TestAttachingStopsWhenTheAttemptDiesWithoutAResult(t *testing.T) {
	t.Parallel()

	// Otherwise the stage waits out its whole timeout for a process that is
	// already gone — an hour of nothing, once per retry.
	pods, files := newFakes()
	pods.alivePID = 4321
	pods.onPgrepPoll = func(calls int) {
		if calls == 2 {
			pods.alivePID = 0
		}
	}

	if _, err := newTestRunner(pods, files).RunStage(context.Background(), testRun(), func([]byte) {}); err == nil {
		t.Error("RunStage() = nil error after the attached attempt died with no result")
	}
}

func TestACancelledContextStopsAStageInsteadOfPolling(t *testing.T) {
	t.Parallel()

	pods, files := newFakes()
	pods.alivePID = 4321
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := newTestRunner(pods, files).RunStage(ctx, testRun(), func([]byte) {}); !errors.Is(err, context.Canceled) {
		t.Errorf("RunStage(cancelled) = %v, want context.Canceled", err)
	}
}

func TestAnUnreadableSandboxNeverBecomesAReRun(t *testing.T) {
	t.Parallel()

	// A wrong "run" costs a full model invocation. If the sandbox cannot be
	// read, the honest answer is an error the activity can retry cheaply.
	pods, files := newFakes()
	files.readErr = errors.New("the apiserver said no")

	if _, err := newTestRunner(pods, files).RunStage(context.Background(), testRun(), func([]byte) {}); err == nil {
		t.Fatal("RunStage() = nil error when the sandbox could not be read")
	}
	if pods.codexCalls() != 0 {
		t.Errorf("codex was invoked %d times despite an unreadable sandbox", pods.codexCalls())
	}
}

// --- fakes -----------------------------------------------------------------

func newTestRunner(pods *fakePods, files *fakeFiles) *Runner {
	return NewRunner(pods, files, clocktest.NewFake(time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)),
		slog.New(slog.DiscardHandler))
}

func newFakes() (*fakePods, *fakeFiles) {
	return &fakePods{}, &fakeFiles{files: map[string][]byte{}}
}

// execCall is one exec the runner made.
type execCall struct {
	argv           []string
	stdin          string
	stdout, stderr io.Writer
}

type fakePods struct {
	mu       sync.Mutex
	calls    []execCall
	alivePID int
	// aliveOutput overrides what an exit-0 pgrep writes to stdout, so a test
	// can express "pgrep found a process but its output does not parse as a
	// PID" — a warning line, or nothing at all.
	aliveOutput *string
	pgrepCalls  int
	onCodex     func(*execCall) (int, error)
	onPgrepPoll func(calls int)
}

func (f *fakePods) Exec(_ context.Context, _ work.SandboxID, argv []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	call := execCall{argv: argv, stdout: stdout, stderr: stderr}
	if stdin != nil {
		read, err := io.ReadAll(stdin)
		if err != nil {
			return 0, err
		}
		call.stdin = string(read)
	}

	f.mu.Lock()
	f.calls = append(f.calls, call)
	if argv[0] == "pgrep" {
		f.pgrepCalls++
		calls, hook := f.pgrepCalls, f.onPgrepPoll
		f.mu.Unlock()
		if hook != nil {
			hook(calls)
		}
		f.mu.Lock()
		pid := f.alivePID
		f.mu.Unlock()
		f.mu.Lock()
		override := f.aliveOutput
		f.mu.Unlock()
		if override != nil {
			if _, err := io.WriteString(stdout, *override); err != nil {
				return 0, err
			}
			return 0, nil
		}
		if pid == 0 {
			return 1, nil
		}
		if _, err := fmt.Fprintf(stdout, "%d\n", pid); err != nil {
			return 0, err
		}
		return 0, nil
	}
	handler := f.onCodex
	f.mu.Unlock()

	if handler == nil {
		return 0, nil
	}
	return handler(&call)
}

func (f *fakePods) codexCalls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c.argv[0] == "codex" {
			n++
		}
	}
	return n
}

func (f *fakePods) codexCall(t *testing.T) execCall {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if c.argv[0] == "codex" {
			return c
		}
	}
	t.Fatal("codex was never invoked")
	return execCall{}
}

// writesResult scripts a codex run: emit these event lines, write the result
// file, exit 0.
func writesResult(files *fakeFiles, result string, events ...string) func(*execCall) (int, error) {
	return func(c *execCall) (int, error) {
		for _, e := range events {
			if _, err := fmt.Fprintln(c.stdout, e); err != nil {
				return 0, err
			}
		}
		if idx := slices.Index(c.argv, "--output-last-message"); idx >= 0 && idx+1 < len(c.argv) {
			files.put(c.argv[idx+1], []byte(result))
		}
		return 0, nil
	}
}

type fakeFiles struct {
	mu      sync.Mutex
	files   map[string][]byte
	readErr error
}

func (f *fakeFiles) Write(_ context.Context, _ work.SandboxID, path string, content []byte, _ fs.FileMode) error {
	f.put(path, content)
	return nil
}

func (f *fakeFiles) Read(_ context.Context, _ work.SandboxID, path string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.readErr != nil {
		return nil, f.readErr
	}
	content, ok := f.files[path]
	if !ok {
		return nil, fmt.Errorf("reading %s: %w", path, work.ErrFileNotFound)
	}
	return bytes.Clone(content), nil
}

func (f *fakeFiles) put(path string, content []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.files[path] = bytes.Clone(content)
}

func (f *fakeFiles) content(path string) []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.files[path]
}
