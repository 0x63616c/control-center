package codex

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// stageFileMode is the mode the prompt and schema are written with. They are
// the sandbox's own working files and nothing else reads them.
const stageFileMode fs.FileMode = 0o600

// defaultPollInterval is how often an attached attempt is checked on. It is a
// poll rather than a wait because pods/exec offers nothing to wait on, and it
// is slow because the thing being waited for takes minutes.
const defaultPollInterval = 15 * time.Second

// stderrKeep is how much of a stage's stderr is held for its error message.
// stderr is evidence and the tail of it is the cause, but the whole of it can
// be a stage's entire noisy life.
const stderrKeep = 64 << 10

// Runner executes pipeline stages by invoking codex inside a sandbox.
//
// It is idempotent by construction rather than by care: every attempt begins by
// asking what the previous one left behind, and the paths it asks about are
// derived from the stage key alone. A retry therefore reads a finished stage's
// result, attaches to a live one, and only runs when neither is true — which is
// what makes a worker restart cheap instead of another model invocation.
type Runner struct {
	pods         PodExecer
	files        FileTransfer
	clock        clock.Clock
	logger       *slog.Logger
	pollInterval time.Duration
}

// Option adjusts a Runner. Required dependencies are positional; only things
// with a sane default are optional.
type Option func(*Runner)

// WithPollInterval sets how often an attached attempt is checked on.
func WithPollInterval(d time.Duration) Option {
	return func(r *Runner) { r.pollInterval = d }
}

// NewRunner builds a Runner over a sandbox's exec and file transports.
func NewRunner(pods PodExecer, files FileTransfer, clk clock.Clock, logger *slog.Logger, opts ...Option) *Runner {
	r := &Runner{pods: pods, files: files, clock: clk, logger: logger, pollInterval: defaultPollInterval}
	for _, opt := range opts {
		opt(r)
	}
	return r
}

// RunStage executes one stage, or resumes whatever a previous attempt of it
// left behind.
func (r *Runner) RunStage(ctx context.Context, run work.StageRun, events work.StageEventSink) (work.StageResult, error) {
	paths := run.Key.Paths()
	probe := &sandboxProbe{runner: r, sandbox: run.Sandbox, paths: paths}

	decision, err := Decide(ctx, probe)
	if err != nil {
		return work.StageResult{}, fmt.Errorf("deciding what to do about %s: %w", run.Key, err)
	}
	r.logger.InfoContext(ctx, "stage resumption decided",
		"ticket", run.Key.Ticket, "run_id", run.Key.RunID, "stage", run.Key.Stage, "decision", decision.String())

	switch decision {
	case ResumeDone:
		return r.storedResult(ctx, run, paths)
	case ResumeAttach:
		if err := r.waitForResult(ctx, run, probe); err != nil {
			return work.StageResult{}, err
		}
		return r.storedResult(ctx, run, paths)
	case ResumeRun:
		return r.run(ctx, run, events, paths)
	default:
		return work.StageResult{}, fmt.Errorf("unknown resumption %s for %s: %w", decision, run.Key, work.ErrPermanent)
	}
}

// run executes the stage: prompt and schema in, codex, result out.
func (r *Runner) run(ctx context.Context, run work.StageRun, events work.StageEventSink, paths work.StagePaths) (work.StageResult, error) {
	// Written before the run and kept afterwards. codex is handed the prompt on
	// stdin, so the file is not how it arrives — it is the record of what was
	// asked, which is the first thing anyone reading a strange result wants.
	if err := r.files.Write(ctx, run.Sandbox, paths.Prompt, []byte(run.Prompt), stageFileMode); err != nil {
		return work.StageResult{}, fmt.Errorf("writing the prompt for %s: %w", run.Key, err)
	}
	if err := r.files.Write(ctx, run.Sandbox, paths.Schema, run.Schema, stageFileMode); err != nil {
		return work.StageResult{}, fmt.Errorf("writing the output schema for %s: %w", run.Key, err)
	}

	stream, exitCode, err := r.exec(ctx, run, events)
	if err != nil {
		return work.StageResult{}, err
	}
	if err := classify(exitCode, stream.outcome, stream.stderr); err != nil {
		return work.StageResult{}, fmt.Errorf("%s: %w", run.Key, err)
	}

	output, err := r.readResult(ctx, run, paths)
	if err != nil {
		return work.StageResult{}, err
	}
	return work.StageResult{Output: output, ThreadID: stream.ThreadID, Usage: stream.Usage}, nil
}

// streamed is what one codex invocation produced.
type streamed struct {
	outcome
	stderr []byte
}

// exec runs codex and reads its two streams at once.
//
// stdout is parsed as it arrives rather than buffered, because the event sink
// is also the enclosing activity's heartbeat: a stage that reports nothing for
// the heartbeat timeout is treated as dead, and a stage that reported
// everything at the end would be treated as dead for an hour and then finish.
func (r *Runner) exec(ctx context.Context, run work.StageRun, events work.StageEventSink) (streamed, int, error) {
	reader, writer := io.Pipe()
	var stderr tailWriter
	stderr.limit = stderrKeep

	parsed := make(chan outcome, 1)
	parseErr := make(chan error, 1)
	go func() {
		out, err := parseStream(reader, events)
		// Drain whatever is left so a parse that stopped early cannot block the
		// exec writing into the pipe.
		_, _ = io.Copy(io.Discard, reader)
		parsed <- out
		parseErr <- err
	}()

	exitCode, execErr := r.pods.Exec(ctx, run.Sandbox, stageArgv(run), strings.NewReader(run.Prompt), writer, &stderr)
	// Closing the write end is what ends the parse; it must happen whether the
	// exec succeeded or not.
	_ = writer.Close()
	out := <-parsed
	err := <-parseErr

	if execErr != nil {
		return streamed{}, 0, fmt.Errorf("running codex for %s: %w", run.Key, execErr)
	}
	if err != nil {
		return streamed{}, 0, fmt.Errorf("reading the event stream for %s: %w", run.Key, err)
	}
	return streamed{outcome: out, stderr: stderr.Bytes()}, exitCode, nil
}

// storedResult reads a result a previous attempt left behind.
//
// Usage and ThreadID are deliberately left zero. They arrived on the event
// stream of a process this attempt was never attached to, and that stream is
// gone. Zero under-reports what the run spent, which is a real gap and is
// logged; inventing a number would be worse, because nothing downstream could
// tell it from a measurement.
func (r *Runner) storedResult(ctx context.Context, run work.StageRun, paths work.StagePaths) (work.StageResult, error) {
	output, err := r.readResult(ctx, run, paths)
	if err != nil {
		return work.StageResult{}, err
	}
	r.logger.WarnContext(ctx, "stage resumed from a stored result; its token usage is not attributed",
		"ticket", run.Key.Ticket, "run_id", run.Key.RunID, "stage", run.Key.Stage)
	return work.StageResult{Output: output}, nil
}

// readResult reads the stage's result file, which is its whole output.
func (r *Runner) readResult(ctx context.Context, run work.StageRun, paths work.StagePaths) ([]byte, error) {
	output, err := r.files.Read(ctx, run.Sandbox, paths.Result)
	if errors.Is(err, work.ErrFileNotFound) {
		// codex exited without answering in its schema. Carrying that forward
		// would hand the next stage an empty document as though it were a plan.
		return nil, fmt.Errorf("%s finished but wrote no result to %s: the model answered outside its output schema", run.Key, paths.Result)
	}
	if err != nil {
		return nil, fmt.Errorf("reading the result of %s: %w", run.Key, err)
	}
	return output, nil
}

// waitForResult attaches to a live attempt: it waits for that attempt's result
// rather than starting a second model against the same sandbox.
//
// It stops when the attempt dies without writing one, rather than waiting out
// the stage timeout for a process that is already gone.
func (r *Runner) waitForResult(ctx context.Context, run work.StageRun, probe *sandboxProbe) error {
	for {
		if err := r.clock.Sleep(ctx, r.pollInterval); err != nil {
			return fmt.Errorf("waiting for the live attempt of %s: %w", run.Key, err)
		}

		done, err := probe.ResultExists(ctx)
		if err != nil {
			return fmt.Errorf("checking on the live attempt of %s: %w", run.Key, err)
		}
		if done {
			return nil
		}

		_, alive, err := probe.LivePID(ctx)
		if err != nil {
			return fmt.Errorf("checking whether the attempt of %s is still alive: %w", run.Key, err)
		}
		if alive {
			continue
		}

		// It died between our checks; it may have finished in that window.
		done, err = probe.ResultExists(ctx)
		if err != nil {
			return fmt.Errorf("re-checking the result of %s: %w", run.Key, err)
		}
		if done {
			return nil
		}
		return fmt.Errorf("the running attempt of %s died without writing a result", run.Key)
	}
}

// sandboxProbe answers Decide's two questions about one stage's sandbox.
type sandboxProbe struct {
	runner  *Runner
	sandbox work.SandboxID
	paths   work.StagePaths
}

// ResultExists reports whether the stage's result file is present.
//
// Absence and unreadability are held apart deliberately: FileTransfer promises
// ErrFileNotFound for absence and only for absence, and collapsing the two here
// would turn a transient read failure into a paid-for re-run of a finished
// stage.
func (p *sandboxProbe) ResultExists(ctx context.Context) (bool, error) {
	_, err := p.runner.files.Read(ctx, p.sandbox, p.paths.Result)
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, work.ErrFileNotFound):
		return false, nil
	default:
		return false, fmt.Errorf("reading %s: %w", p.paths.Result, err)
	}
}

// LivePID reports whether a codex for this stage is still running.
//
// It asks the process table rather than reading a PID file, and the difference
// is not convenience. A PID file can only be written by the process itself,
// which needs either a shell or a wrapper in the sandbox image; and a PID
// outlives its process, so a recycled number would read as "still running" and
// hang the stage until its timeout. Matching codex's own argv on this attempt's
// result path — a path derived from a ticket number, a Temporal RunID and a
// stage name, none of which an issue author can steer — can only match the
// process this stage started.
func (p *sandboxProbe) LivePID(ctx context.Context) (int, bool, error) {
	var out bytes.Buffer
	argv := []string{"pgrep", "-f", p.paths.Result}

	code, err := p.runner.pods.Exec(ctx, p.sandbox, argv, nil, &out, io.Discard)
	if err != nil {
		return 0, false, fmt.Errorf("looking for a running attempt in sandbox %s: %w", p.sandbox, err)
	}
	switch code {
	case 0:
		return parsePID(out.String()), true, nil
	case 1:
		// pgrep's own "nothing matched", which is the normal answer.
		return 0, false, nil
	default:
		return 0, false, fmt.Errorf("pgrep failed in sandbox %s (exit %d): %s", p.sandbox, code, strings.TrimSpace(out.String()))
	}
}

// parsePID reads the first PID pgrep printed. More than one match means codex
// re-execed itself; any of them being alive is the answer this is asked for.
func parsePID(out string) int {
	first, _, _ := strings.Cut(strings.TrimSpace(out), "\n")
	pid, err := strconv.Atoi(strings.TrimSpace(first))
	if err != nil {
		return 0
	}
	return pid
}

// tailWriter keeps the last limit bytes written to it.
//
// stderr is unbounded and mostly progress noise; the cause of a failure is at
// its end. Holding all of it would put a stage's whole log into memory and then
// into an error message that reaches Temporal history.
type tailWriter struct {
	buf   []byte
	limit int
}

func (w *tailWriter) Write(p []byte) (int, error) {
	w.buf = append(w.buf, p...)
	if len(w.buf) > w.limit {
		w.buf = append([]byte(nil), w.buf[len(w.buf)-w.limit:]...)
	}
	return len(p), nil
}

// Bytes returns what was kept.
func (w *tailWriter) Bytes() []byte { return w.buf }
