package activities

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/github"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/testsuite"
)

// --- fakes -----------------------------------------------------------------

type fakeGitHub struct {
	tickets []work.Ticket
	detail  work.TicketDetail

	postErr, editErr, labelErr, listErr, detailErr error

	postedTo   int
	postedBody string
	editedID   work.CommentID
	editedBody string
	cleared    []int
	nextID     work.CommentID
}

func (f *fakeGitHub) ListAutoTickets(context.Context) ([]work.Ticket, error) {
	return f.tickets, f.listErr
}

func (f *fakeGitHub) TicketDetail(_ context.Context, _ int) (work.TicketDetail, error) {
	return f.detail, f.detailErr
}

func (f *fakeGitHub) PostStatus(_ context.Context, issue int, body string) (work.CommentID, error) {
	f.postedTo, f.postedBody = issue, body
	return f.nextID, f.postErr
}

func (f *fakeGitHub) EditStatus(_ context.Context, id work.CommentID, body string) error {
	f.editedID, f.editedBody = id, body
	return f.editErr
}

func (f *fakeGitHub) ClearAutoLabel(_ context.Context, issue int) error {
	f.cleared = append(f.cleared, issue)
	return f.labelErr
}

func (f *fakeGitHub) InstallationToken(context.Context) (work.Credential, error) {
	return work.Credential{}, nil
}

type fakePods struct {
	created   []work.SandboxSpec
	deleted   []work.SandboxID
	createErr error
	readyErr  error
	deleteErr error
}

func (f *fakePods) Create(_ context.Context, spec work.SandboxSpec) (work.SandboxID, error) {
	f.created = append(f.created, spec)
	return work.SandboxID(fmt.Sprintf("sandbox-%d", spec.TicketNumber)), f.createErr
}

func (f *fakePods) WaitReady(context.Context, work.SandboxID) error { return f.readyErr }

func (f *fakePods) Delete(_ context.Context, id work.SandboxID) error {
	f.deleted = append(f.deleted, id)
	return f.deleteErr
}

type fakeStages struct {
	events  [][]byte
	result  work.StageResult
	err     error
	sawRun  work.StageRun
	ranOnce bool
}

func (f *fakeStages) RunStage(_ context.Context, run work.StageRun, sink work.StageEventSink) (work.StageResult, error) {
	f.sawRun, f.ranOnce = run, true
	for _, e := range f.events {
		sink(e)
	}
	return f.result, f.err
}

// fakeTranscript records what was written and whether it was closed.
type fakeTranscript struct {
	buf      bytes.Buffer
	closed   atomic.Bool
	writeErr error
	openErr  error
}

func (f *fakeTranscript) Open(context.Context, work.StageKey) (io.WriteCloser, error) {
	if f.openErr != nil {
		return nil, f.openErr
	}
	return f, nil
}

func (f *fakeTranscript) Write(p []byte) (int, error) {
	if f.writeErr != nil {
		return 0, f.writeErr
	}
	return f.buf.Write(p)
}

func (f *fakeTranscript) Close() error {
	f.closed.Store(true)
	return nil
}

type fakePrompts struct {
	prompt  string
	schema  []byte
	err     error
	verdict work.StageVerdict

	sawStage   work.Stage
	sawHandoff []byte
}

func (f *fakePrompts) Verdict(work.Stage, []byte) (work.StageVerdict, error) {
	return f.verdict, nil
}

func (f *fakePrompts) Render(stage work.Stage, _ work.TicketDetail, handoff []byte) (string, []byte, error) {
	f.sawStage, f.sawHandoff = stage, handoff
	return f.prompt, f.schema, f.err
}

// fakeStatus renders a report to something a test can recognise without
// depending on the real wording, which A3 owns.
type fakeStatus struct{ saw work.StatusReport }

func (f *fakeStatus) Render(report work.StatusReport) string {
	f.saw = report
	return fmt.Sprintf("run %s stage %s", report.RunID, report.Stage)
}

type fakeRuns struct {
	state work.RunState
	err   error
	saw   string
}

func (f *fakeRuns) Describe(_ context.Context, workflowID string) (work.RunState, error) {
	f.saw = workflowID
	return f.state, f.err
}

type fakeSweeper struct {
	deleted    int
	err        error
	sawLive    []string
	sawMinAge  time.Duration
	sweepCalls int
}

func (f *fakeSweeper) SweepOrphans(_ context.Context, live []string, minAge time.Duration) (int, error) {
	f.sawLive, f.sawMinAge = live, minAge
	f.sweepCalls++
	return f.deleted, f.err
}

// --- harness ---------------------------------------------------------------

func template() work.SandboxTemplate {
	return work.SandboxTemplate{
		Image:           "ghcr.io/example/sandbox:v1",
		CPULimit:        "2",
		MemoryLimit:     "4Gi",
		DeadlineSeconds: int64((6 * time.Hour).Seconds()),
		Env:             map[string]string{"CODEX_HOME": "/work/.codex"},
	}
}

func deps() Deps {
	return Deps{
		GitHub:      &fakeGitHub{},
		Pods:        &fakePods{},
		Stages:      &fakeStages{},
		Transcripts: &fakeTranscript{},
		Prompts:     &fakePrompts{},
		Status:      &fakeStatus{},
		Runs:        &fakeRuns{},
		Sweeper:     &fakeSweeper{},
		Sandbox:     template(),
	}
}

func mustNew(t *testing.T, d Deps) *Activities {
	t.Helper()
	a, err := New(d)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return a
}

// env runs an activity the way the worker would, so the activity context is
// real: heartbeats and the logger are the SDK's, not stubs.
func env(t *testing.T) *testsuite.TestActivityEnvironment {
	t.Helper()
	suite := &testsuite.WorkflowTestSuite{}
	return suite.NewTestActivityEnvironment()
}

// --- construction ----------------------------------------------------------

func TestNewNamesEveryDependencyItIsMissing(t *testing.T) {
	t.Parallel()

	_, err := New(Deps{Sandbox: template()})
	if err == nil {
		t.Fatal("a set of activities with no dependencies must not construct")
	}
	for _, name := range []string{"GitHub", "Pods", "Stages", "Transcripts", "Prompts", "Status", "Runs", "Sweeper"} {
		if !strings.Contains(err.Error(), name) {
			t.Fatalf("error %q does not name the missing %s", err, name)
		}
	}
}

func TestNewRefusesASandboxTemplateItCannotBuildAPodFrom(t *testing.T) {
	t.Parallel()

	d := deps()
	d.Sandbox.Image = ""

	if _, err := New(d); !errors.Is(err, work.ErrInvalidConfig) {
		t.Fatalf("an imageless template must fail construction, got %v", err)
	}
}

// --- github activities -----------------------------------------------------

func TestReportStatusPostsWhenNoCommentExistsYet(t *testing.T) {
	t.Parallel()

	gh := &fakeGitHub{nextID: 77}
	d := deps()
	d.GitHub = gh
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.ReportStatus)

	val, err := e.ExecuteActivity(a.ReportStatus, work.StatusReport{TicketNumber: 328, RunID: "run-1", Stage: work.StagePlan})
	if err != nil {
		t.Fatalf("ReportStatus: %v", err)
	}

	var id work.CommentID
	if err := val.Get(&id); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if id != 77 || gh.postedTo != 328 {
		t.Fatalf("posted to %d returning %d, want 328 / 77", gh.postedTo, id)
	}
	if gh.editedID != 0 {
		t.Fatal("a run with no comment must not edit one")
	}
}

func TestReportStatusEditsTheCommentTheRunAlreadyPosted(t *testing.T) {
	t.Parallel()

	gh := &fakeGitHub{}
	d := deps()
	d.GitHub = gh
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.ReportStatus)

	val, err := e.ExecuteActivity(a.ReportStatus, work.StatusReport{TicketNumber: 328, RunID: "run-1", Comment: 77})
	if err != nil {
		t.Fatalf("ReportStatus: %v", err)
	}

	var id work.CommentID
	if err := val.Get(&id); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if gh.editedID != 77 || id != 77 {
		t.Fatalf("edited %d returning %d, want 77 both — one comment per run, edited in place", gh.editedID, id)
	}
	if gh.postedTo != 0 {
		t.Fatal("a run that has already posted must not post a second comment")
	}
}

func TestClearAutoLabelSurfacesAnAuthFailureAsTheTypeThatPausesTheDispatcher(t *testing.T) {
	t.Parallel()

	gh := &fakeGitHub{labelErr: fmt.Errorf("clearing: %w (%w): %w", github.ErrAuth, work.ErrPermanent, errors.New("403"))}
	d := deps()
	d.GitHub = gh
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.ClearAutoLabel)

	_, err := e.ExecuteActivity(a.ClearAutoLabel, 328)
	if err == nil {
		t.Fatal("an auth failure must fail the activity")
	}
	if got := FailureKindOf(err); got != work.FailureAuth {
		t.Fatalf("FailureKindOf = %q, want %q — this is what pauses the dispatcher", got, work.FailureAuth)
	}
}

// --- sandbox lifecycle -----------------------------------------------------

func TestCreateSandboxRefusesAPodDeadlineTheRunCanOutlive(t *testing.T) {
	t.Parallel()

	d := deps()
	d.Sandbox.DeadlineSeconds = 60
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.CreateSandbox)

	_, err := e.ExecuteActivity(a.CreateSandbox, CreateSandboxInput{
		TicketNumber: 1, RunID: "run-1", RunBudget: 5 * time.Hour,
	})
	if err == nil {
		t.Fatal("Kubernetes must never be able to kill a pod Temporal still believes in")
	}
	if d.Pods.(*fakePods).created != nil {
		t.Fatal("the pod must not have been created at all")
	}
	if got := errTypeOf(t, err); got != ErrTypePermanent {
		t.Fatalf("type = %q, want %q — no retry changes a deploy-time number", got, ErrTypePermanent)
	}
}

func TestCreateSandboxNamesThePodForTheRunAndTheTicket(t *testing.T) {
	t.Parallel()

	pods := &fakePods{}
	d := deps()
	d.Pods = pods
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.CreateSandbox)

	if _, err := e.ExecuteActivity(a.CreateSandbox, CreateSandboxInput{
		TicketNumber: 328, RunID: "run-1", RunBudget: 5 * time.Hour,
	}); err != nil {
		t.Fatalf("CreateSandbox: %v", err)
	}

	if len(pods.created) != 1 {
		t.Fatalf("created %d pods, want 1", len(pods.created))
	}
	spec := pods.created[0]
	if spec.TicketNumber != 328 || spec.RunID != "run-1" {
		t.Fatalf("spec = %+v, want ticket 328 run run-1", spec)
	}
	if spec.Image != template().Image || spec.CPULimit != template().CPULimit {
		t.Fatalf("spec did not come from the template: %+v", spec)
	}
}

// --- stages ----------------------------------------------------------------

func stageInput(stage work.Stage, handoff []byte) RunStageInput {
	return RunStageInput{
		Key:     work.StageKey{Ticket: 328, RunID: "run-1", Stage: stage},
		Sandbox: "sandbox-328",
		Model:   work.Model{Name: "gpt-5.6-terra", Effort: "medium"},
		Detail:  work.TicketDetail{Ticket: work.Ticket{Number: 328, Title: "t", Body: "b"}},
		Handoff: handoff,
	}
}

func TestRunStageWritesOneTerminatedLinePerEventToTheTranscript(t *testing.T) {
	t.Parallel()

	transcript := &fakeTranscript{}
	stages := &fakeStages{
		events: [][]byte{[]byte(`{"type":"turn.started"}`), []byte(`{"type":"turn.completed"}`)},
		result: work.StageResult{Output: []byte(`{"ok":true}`), ThreadID: "thread-1"},
	}
	d := deps()
	d.Transcripts, d.Stages = transcript, stages
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.RunStage)

	if _, err := e.ExecuteActivity(a.RunStage, stageInput(work.StagePlan, nil)); err != nil {
		t.Fatalf("RunStage: %v", err)
	}

	want := `{"type":"turn.started"}` + "\n" + `{"type":"turn.completed"}` + "\n"
	if got := transcript.buf.String(); got != want {
		t.Fatalf("transcript = %q, want %q — framing has exactly one owner", got, want)
	}
	if !transcript.closed.Load() {
		t.Fatal("the transcript must be closed")
	}
}

func TestRunStageHeartbeatsOffTheEventStreamSoAStuckStageIsSeenAsDeadRatherThanSlow(t *testing.T) {
	t.Parallel()

	// The SDK throttles heartbeats, so the count is the SDK's business and not
	// this test's. What is asserted is the thing the code owns: the heartbeat is
	// driven by the stage's own output, and by nothing else. A stage that emits
	// nothing must therefore heartbeat nothing — that is what makes it look dead
	// rather than slow.
	cases := map[string]struct {
		events   [][]byte
		wantBeat bool
	}{
		"a stage that is emitting events": {events: [][]byte{[]byte("a"), []byte("b")}, wantBeat: true},
		"a stage that has gone silent":    {events: nil, wantBeat: false},
	}

	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			var beats atomic.Int32
			d := deps()
			d.Stages = &fakeStages{events: c.events}
			e := env(t)
			e.SetOnActivityHeartbeatListener(func(_ *activity.Info, _ converter.EncodedValues) {
				beats.Add(1)
			})
			a := mustNew(t, d)
			e.RegisterActivity(a.RunStage)

			if _, err := e.ExecuteActivity(a.RunStage, stageInput(work.StagePlan, nil)); err != nil {
				t.Fatalf("RunStage: %v", err)
			}

			if got := beats.Load() > 0; got != c.wantBeat {
				t.Fatalf("heartbeated = %v (%d beats), want %v", got, beats.Load(), c.wantBeat)
			}
		})
	}
}

func TestRunStageKeepsGoingWhenTheTranscriptCannotBeWritten(t *testing.T) {
	t.Parallel()

	transcript := &fakeTranscript{writeErr: errors.New("volume full")}
	stages := &fakeStages{
		events: [][]byte{[]byte("a")},
		result: work.StageResult{Output: []byte(`{"ok":true}`)},
	}
	d := deps()
	d.Transcripts, d.Stages = transcript, stages
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.RunStage)

	val, err := e.ExecuteActivity(a.RunStage, stageInput(work.StagePlan, nil))
	if err != nil {
		t.Fatalf("losing the record of the work is cheaper than losing the work: %v", err)
	}

	var out RunStageOutput
	if err := val.Get(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if string(out.Output) != `{"ok":true}` {
		t.Fatalf("output = %q, want the stage's own result", out.Output)
	}
}

func TestRunStageClosesTheTranscriptWhenTheStageFails(t *testing.T) {
	t.Parallel()

	transcript := &fakeTranscript{}
	d := deps()
	d.Transcripts = transcript
	d.Stages = &fakeStages{err: errors.New("exit 1")}
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.RunStage)

	if _, err := e.ExecuteActivity(a.RunStage, stageInput(work.StagePlan, nil)); err == nil {
		t.Fatal("a failed stage fails its activity")
	}
	if !transcript.closed.Load() {
		t.Fatal("a failed stage's transcript is the one most worth reading, so it must still be closed")
	}
}

func TestRunStageHandsThePrecedingStagesOutputToTheRendererUntouched(t *testing.T) {
	t.Parallel()

	prompts := &fakePrompts{prompt: "do the thing", schema: []byte(`{"type":"object"}`)}
	stages := &fakeStages{}
	d := deps()
	d.Prompts, d.Stages = prompts, stages
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.RunStage)

	handoff := []byte(`{"plan":"…"}`)
	if _, err := e.ExecuteActivity(a.RunStage, stageInput(work.StageReview, handoff)); err != nil {
		t.Fatalf("RunStage: %v", err)
	}

	if prompts.sawStage != work.StageReview || string(prompts.sawHandoff) != string(handoff) {
		t.Fatalf("renderer saw stage %q handoff %q", prompts.sawStage, prompts.sawHandoff)
	}
	if stages.sawRun.Prompt != "do the thing" || string(stages.sawRun.Schema) != `{"type":"object"}` {
		t.Fatalf("the rendered prompt and schema must reach the stage runner, got %+v", stages.sawRun)
	}
}

func TestRunStageDoesNotStartTheStageWhenTheTranscriptCannotBeOpened(t *testing.T) {
	t.Parallel()

	stages := &fakeStages{}
	d := deps()
	d.Transcripts = &fakeTranscript{openErr: errors.New("no such volume")}
	d.Stages = stages
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.RunStage)

	if _, err := e.ExecuteActivity(a.RunStage, stageInput(work.StagePlan, nil)); err == nil {
		t.Fatal("an unopenable transcript fails the stage")
	}
	if stages.ranOnce {
		t.Fatal("tokens must not be spent on a stage whose record cannot be kept")
	}
}

// --- reconcile and sweep ---------------------------------------------------

func TestDescribeRunAsksAboutTheWorkflowIDItWasGiven(t *testing.T) {
	t.Parallel()

	runs := &fakeRuns{state: work.RunState{Open: true, RunID: "run-9"}}
	d := deps()
	d.Runs = runs
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.DescribeRun)

	val, err := e.ExecuteActivity(a.DescribeRun, work.WorkflowID(328))
	if err != nil {
		t.Fatalf("DescribeRun: %v", err)
	}

	var state work.RunState
	if err := val.Get(&state); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if runs.saw != "work-ticket-328" || !state.Open || state.RunID != "run-9" {
		t.Fatalf("looked up %q, got %+v", runs.saw, state)
	}
}

func TestSweepRefusesToRunWithoutAnAgeFloor(t *testing.T) {
	t.Parallel()

	sweeper := &fakeSweeper{}
	d := deps()
	d.Sweeper = sweeper
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.SweepOrphanSandboxes)

	_, err := e.ExecuteActivity(a.SweepOrphanSandboxes, SweepInput{LiveRunIDs: []string{"run-1"}})
	if err == nil {
		t.Fatal("a sweep with no age floor would delete pods out from under their own runs")
	}
	if sweeper.sweepCalls != 0 {
		t.Fatal("and it must not have reached the cluster to find that out")
	}
}

func TestSweepPassesTheLiveRunsAndTheFloorThrough(t *testing.T) {
	t.Parallel()

	sweeper := &fakeSweeper{deleted: 2}
	d := deps()
	d.Sweeper = sweeper
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.SweepOrphanSandboxes)

	val, err := e.ExecuteActivity(a.SweepOrphanSandboxes, SweepInput{
		LiveRunIDs: []string{"run-1", "run-2"}, MinAge: 30 * time.Minute,
	})
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}

	var result SweepResult
	if err := val.Get(&result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(sweeper.sawLive) != 2 || sweeper.sawMinAge != 30*time.Minute || result.Deleted != 2 {
		t.Fatalf("live=%v minAge=%s deleted=%d", sweeper.sawLive, sweeper.sawMinAge, result.Deleted)
	}
}

// errTypeOf reads the ApplicationError type off an activity failure.
func errTypeOf(t *testing.T, err error) string {
	t.Helper()
	return appErrorOf(t, err).Type()
}
