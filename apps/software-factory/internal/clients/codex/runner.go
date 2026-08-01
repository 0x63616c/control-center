package codex

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"strings"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// stageFileMode is the mode the prompt and schema are written with. They are
// the sandbox's own working files and nothing else reads them.
const stageFileMode fs.FileMode = 0o600

// stderrKeep is how much of a stage's stderr is held for its error message.
// stderr is evidence and the tail of it is the cause, but the whole of it can
// be a stage's entire noisy life.
const stderrKeep = 64 << 10

// Runner executes pipeline stages by invoking codex inside a sandbox.
//
// It is idempotent by construction rather than by care: every attempt begins by
// asking what the previous one left behind, and the paths it asks about are
// derived from the stage key alone. A retry therefore reads a finished stage's
// result and only runs when that is absent — which is what makes a retry
// within the same session cheap instead of another model invocation.
//
// It no longer holds a clock or a poll interval. Both existed only for
// waitForResult, the cross-process reattach Sessions removed (#434) — see
// resume.go's Resumption doc comment.
type Runner struct {
	pods   PodExecer
	files  FileTransfer
	locks  StageLocker
	logger *slog.Logger
}

// NewRunner builds a Runner over a sandbox's exec and file transports.
func NewRunner(pods PodExecer, files FileTransfer, locks StageLocker, logger *slog.Logger) *Runner {
	return &Runner{pods: pods, files: files, locks: locks, logger: logger}
}

// RunStage executes one stage, or resumes whatever a previous attempt of it
// left behind.
func (r *Runner) RunStage(ctx context.Context, run work.StageRun, events work.StageEventSink) (result work.StageResult, err error) {
	paths := run.Key.Paths()
	lock, err := r.locks.Acquire(ctx, paths.Lock)
	if err != nil {
		return work.StageResult{}, fmt.Errorf("acquiring the codex lock for %s: %w", run.Key, err)
	}
	defer func() {
		if closeErr := lock.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("releasing the codex lock for %s: %w", run.Key, closeErr)
		}
	}()
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
	case ResumeRun:
		return r.run(ctx, run, events, paths)
	default:
		return work.StageResult{}, fmt.Errorf("unknown resumption %s for %s: %w", decision, run.Key, work.ErrPermanent)
	}
}

// RunTargetStage runs one workflow-authorized target Attempt. resumeThreadID
// comes only from the scoped durable checkpoint after local provider state was
// proved available; an absent ID starts the first and only fresh execution for
// that Attempt.
func (r *Runner) RunTargetStage(ctx context.Context, run work.StageRun, resumeThreadID string, events work.StageEventSink) (result work.StageResult, err error) {
	paths := run.Key.Paths()
	lock, err := r.locks.Acquire(ctx, paths.Lock)
	if err != nil {
		return work.StageResult{}, fmt.Errorf("acquiring the target codex lock for %s: %w", run.Key, err)
	}
	defer func() {
		if closeErr := lock.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("releasing the target codex lock for %s: %w", run.Key, closeErr)
		}
	}()
	if done, probeErr := (&sandboxProbe{runner: r, sandbox: run.Sandbox, paths: paths}).ResultExists(ctx); probeErr != nil {
		return work.StageResult{}, fmt.Errorf("checking the target result for %s: %w", run.Key, probeErr)
	} else if done {
		stored, readErr := r.storedResult(ctx, run, paths)
		stored.ThreadID = resumeThreadID
		return stored, readErr
	}
	if err := r.files.Write(ctx, run.Sandbox, paths.Prompt, []byte(run.Prompt), stageFileMode); err != nil {
		return work.StageResult{}, fmt.Errorf("writing the target prompt for %s: %w", run.Key, err)
	}
	if err := r.files.Write(ctx, run.Sandbox, paths.Schema, run.Schema, stageFileMode); err != nil {
		return work.StageResult{}, fmt.Errorf("writing the target output schema for %s: %w", run.Key, err)
	}
	stream, exitCode, err := r.exec(ctx, run, events, resumeThreadID)
	if err != nil {
		return work.StageResult{}, err
	}
	result = work.StageResult{ThreadID: stream.ThreadID, Usage: stream.Usage, UsageMeasured: true}
	if err := classify(exitCode, stream.outcome, stream.stderr); err != nil {
		return result, fmt.Errorf("%s: %w", run.Key, err)
	}
	result.Output, err = r.readResult(ctx, run, paths)
	if err != nil {
		return result, err
	}
	return result, nil
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

	resumeThreadID, err := r.priorThreadID(ctx, run)
	if err != nil {
		return work.StageResult{}, err
	}

	stream, exitCode, err := r.exec(ctx, run, events, resumeThreadID)
	if err != nil {
		return work.StageResult{}, err
	}
	if err := classify(exitCode, stream.outcome, stream.stderr); err != nil {
		return work.StageResult{}, fmt.Errorf("%s: %w", run.Key, err)
	}

	if err := r.saveThreadID(ctx, run, stream.ThreadID); err != nil {
		return work.StageResult{}, err
	}

	output, err := r.readResult(ctx, run, paths)
	if err != nil {
		return work.StageResult{}, err
	}
	return work.StageResult{Output: output, ThreadID: stream.ThreadID, Usage: stream.Usage, UsageMeasured: true}, nil
}

// priorThreadID returns the thread id implement's own previous turn left
// behind, or "" if there is none to resume — either because this is
// implement's first turn of the run, or because run.Key.Stage is not
// implement at all. review is never resumed by construction: this method
// never reads sessionIDFile for anything but StageImplement, so nothing
// downstream of it can accidentally pass a review turn's stageArgv a resume
// argument.
func (r *Runner) priorThreadID(ctx context.Context, run work.StageRun) (string, error) {
	if run.Key.Stage != work.StageImplement {
		return "", nil
	}
	content, err := r.files.Read(ctx, run.Sandbox, sessionIDFile(run.Key))
	if errors.Is(err, work.ErrFileNotFound) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("reading %s's previous session id: %w", run.Key, err)
	}
	return strings.TrimSpace(string(content)), nil
}

// saveThreadID persists implement's own thread id for its next turn to resume,
// and does nothing at all for any other stage — see priorThreadID's doc
// comment for why that asymmetry is deliberate rather than an oversight.
//
// A turn that produced no thread id (verified nowhere in this stream, which
// would itself be surprising) leaves the previous file alone rather than
// overwriting it with nothing: a stale-but-real thread id is a better resume
// target than none at all.
func (r *Runner) saveThreadID(ctx context.Context, run work.StageRun, threadID string) error {
	if run.Key.Stage != work.StageImplement || threadID == "" {
		return nil
	}
	if err := r.files.Write(ctx, run.Sandbox, sessionIDFile(run.Key), []byte(threadID), stageFileMode); err != nil {
		return fmt.Errorf("saving %s's session id for the next turn to resume: %w", run.Key, err)
	}
	return nil
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
func (r *Runner) exec(ctx context.Context, run work.StageRun, events work.StageEventSink, resumeThreadID string) (streamed, int, error) {
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

	exitCode, execErr := r.pods.Exec(ctx, run.Sandbox, stageArgv(run, resumeThreadID), strings.NewReader(run.Prompt), writer, &stderr)
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
// Usage and ThreadID are deliberately left zero, and UsageMeasured is left
// false. They arrived on the event stream of a process this attempt was never
// attached to, and that stream is gone. Inventing a number would be worse than
// under-reporting, because nothing downstream could tell it from a
// measurement — but a bare zero has the same problem one step removed, since
// zero tokens is itself a legitimate reading. UsageMeasured is what makes "we
// did not measure this" expressible to something that is not a human reading
// the WARN below.
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

// sandboxProbe answers Decide's one remaining question about one stage's
// sandbox. Before #434 it answered a second — AttemptRunning — deleted along
// with waitForResult, its only caller: see resume.go's Resumption doc comment
// for why a cross-process "is a previous attempt still running" question no
// longer arises once a stage is a local subprocess of the very activity
// deciding this.
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
