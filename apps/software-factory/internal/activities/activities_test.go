package activities

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codexauth"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/github"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock/clocktest"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/telemetry"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/testsuite"
)

// --- fakes -----------------------------------------------------------------

type fakeGitHub struct {
	tickets          []work.Ticket
	detail           work.TicketDetail
	autoLabelPresent bool

	postErr, editErr, labelErr, failedErr, listErr, detailErr, autoLabelErr error

	postedTo   int
	postedBody string
	editedID   work.CommentID
	editedBody string
	cleared    []int
	failed     []int
	nextID     work.CommentID

	pr          work.PullRequest
	prFound     bool
	prErr       error
	askedBranch string

	token    work.SandboxCredential
	tokenErr error

	checks    []work.CheckRun
	checksErr error
	checksRef string

	openOrUpdatePR    work.PullRequest
	openOrUpdateErr   error
	openOrUpdateInput struct {
		branch, title, body string
		existing            *work.PullRequest
	}

	draftedNodeID   string
	draftErr        error
	readyNodeID     string
	readyErr        error
	autoMergeNodeID string
	autoMergeErr    error
}

func (f *fakeGitHub) ListAutoTickets(context.Context) ([]work.Ticket, error) {
	return f.tickets, f.listErr
}

func (f *fakeGitHub) AutoLabelPresent(_ context.Context, _ int) (bool, error) {
	return f.autoLabelPresent, f.autoLabelErr
}

func (f *fakeGitHub) TicketDetail(_ context.Context, _ int) (work.TicketDetail, error) {
	return f.detail, f.detailErr
}

func (f *fakeGitHub) PostStatus(_ context.Context, issue int, body string) (work.CommentID, error) {
	f.postedTo, f.postedBody = issue, body
	return f.nextID, f.postErr
}

func (f *fakeGitHub) PostDuplicateWorkflowIDRejection(ctx context.Context, issue int, body string) (work.CommentID, error) {
	return f.PostStatus(ctx, issue, body)
}

func (f *fakeGitHub) EditStatus(_ context.Context, id work.CommentID, body string) error {
	f.editedID, f.editedBody = id, body
	return f.editErr
}

func (f *fakeGitHub) ClearAutoLabel(_ context.Context, issue int) error {
	f.cleared = append(f.cleared, issue)
	return f.labelErr
}

func (f *fakeGitHub) MarkFailed(_ context.Context, target int) error {
	f.failed = append(f.failed, target)
	return f.failedErr
}

func (f *fakeGitHub) InstallationToken(context.Context) (work.SandboxCredential, error) {
	return f.token, f.tokenErr
}

func (f *fakeGitHub) PullRequestForBranch(_ context.Context, branch string) (work.PullRequest, bool, error) {
	f.askedBranch = branch
	return f.pr, f.prFound, f.prErr
}

func (f *fakeGitHub) ChecksForRef(_ context.Context, ref string) ([]work.CheckRun, error) {
	f.checksRef = ref
	return f.checks, f.checksErr
}

func (f *fakeGitHub) OpenOrUpdatePullRequest(_ context.Context, branch, title, body string, existing *work.PullRequest) (work.PullRequest, error) {
	f.openOrUpdateInput.branch, f.openOrUpdateInput.title, f.openOrUpdateInput.body, f.openOrUpdateInput.existing = branch, title, body, existing
	return f.openOrUpdatePR, f.openOrUpdateErr
}

func (f *fakeGitHub) ConvertPullRequestToDraft(_ context.Context, nodeID string) error {
	f.draftedNodeID = nodeID
	return f.draftErr
}

func (f *fakeGitHub) MarkPullRequestReadyForReview(_ context.Context, nodeID string) error {
	f.readyNodeID = nodeID
	return f.readyErr
}

func (f *fakeGitHub) EnablePullRequestAutoMerge(_ context.Context, nodeID string) error {
	f.autoMergeNodeID = nodeID
	return f.autoMergeErr
}

type fakePods struct {
	created    []work.SandboxSpec
	sawCredent []work.CredentialFile
	deleted    []work.SandboxID
	createErr  error
	readyErr   error
	deleteErr  error
}

func (f *fakePods) Create(_ context.Context, spec work.SandboxSpec, credential work.CredentialFile) (work.SandboxID, error) {
	f.created = append(f.created, spec)
	f.sawCredent = append(f.sawCredent, credential)
	return work.SandboxID(fmt.Sprintf("sandbox-%d", spec.TicketNumber)), f.createErr
}

func (f *fakePods) WaitReady(context.Context, work.SandboxID) error { return f.readyErr }

func (f *fakePods) Delete(_ context.Context, id work.SandboxID) error {
	f.deleted = append(f.deleted, id)
	return f.deleteErr
}

// fakeRepo records what CloneRepo asked it to clone and with what, and refuses
// to be a well-behaved fake that also invents a passing behaviour on its own —
// callErr is returned untouched, never wrapped in work.ErrPermanent, so a test
// deciding retryability controls it directly.
type fakeRepo struct {
	sawSandbox   work.SandboxID
	sawURL       string
	sawToken     string
	sawLogin     string
	sawAccountID int64
	called       int
	err          error
}

func (f *fakeRepo) CloneRepo(_ context.Context, sandbox work.SandboxID, cloneURL string, credential work.SandboxCredential) error {
	f.called++
	f.sawSandbox, f.sawURL, f.sawToken = sandbox, cloneURL, credential.Token.Reveal()
	f.sawLogin = credential.Login
	f.sawAccountID = credential.AccountID
	return f.err
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
	prompt string
	schema []byte
	err    error

	decodeErr error
	// decode, when set, overrides the default document-shaped decode below —
	// used by tests exercising implement's ImplementOutput shape.
	decode func(stage work.Stage, result []byte) (work.StageOutput, error)

	sawStage work.Stage
	sawKey   work.StageKey
	sawPrior work.PriorTurns
}

func (f *fakePrompts) Render(key work.StageKey, _ work.TicketDetail, prior work.PriorTurns) (string, []byte, error) {
	f.sawStage = key.Stage
	f.sawKey = key
	f.sawPrior = prior
	return f.prompt, f.schema, f.err
}

func (f *fakePrompts) Decode(stage work.Stage, result []byte) (work.StageOutput, error) {
	if f.decodeErr != nil {
		return work.StageOutput{}, f.decodeErr
	}
	if f.decode != nil {
		return f.decode(stage, result)
	}
	switch stage {
	case work.StagePlan:
		return work.NewStageOutput(stage, work.DocumentOutput{Document: "document of " + string(result)}), nil
	case work.StageImplement:
		return work.NewStageOutput(stage, work.ImplementOutput{Report: "document of " + string(result)}), nil
	case work.StageReview:
		return work.NewStageOutput(stage, work.ReviewOutput{Document: "document of " + string(result)}), nil
	default:
		return work.NewStageOutput(stage, work.DocumentOutput{Document: "document of " + string(result)}), nil
	}
}

// fakeStatus renders a report to something a test can recognise without
// depending on the real wording, which A3 owns.
type fakeStatus struct {
	saw          work.StatusReport
	sawRejection work.DuplicateWorkflowExecution
}

func (f *fakeStatus) Render(report work.StatusReport) string {
	f.saw = report
	return fmt.Sprintf("run %s stage %s", report.RunID, report.Stage)
}

func (f *fakeStatus) RenderDuplicateWorkflowID(rejection work.DuplicateWorkflowExecution) string {
	f.sawRejection = rejection
	return "duplicate workflow notice"
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

// fakeMetrics records what was reported, so a test can assert the expensive
// case is not the invisible one.
type fakeMetrics struct {
	stages   []work.Stage
	outcomes []telemetry.Outcome
	usages   []work.Usage
	tooks    []time.Duration
}

func (f *fakeMetrics) StageFinished(stage work.Stage, _ work.Model, outcome telemetry.Outcome, usage work.Usage, took time.Duration) {
	f.stages = append(f.stages, stage)
	f.outcomes = append(f.outcomes, outcome)
	f.usages = append(f.usages, usage)
	f.tooks = append(f.tooks, took)
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

// fakeDispatcherState stands in for the store: it records the last state
// written and can be told to fail, without opening a database.
type fakeDispatcherState struct {
	written store.DispatcherState
	puts    int
	err     error
}

func (f *fakeDispatcherState) PutDispatcherState(_ context.Context, state store.DispatcherState) error {
	f.puts++
	if f.err != nil {
		return f.err
	}
	f.written = state
	return nil
}

// fakeTokenSource stands in for codexauth.Source: it yields a fixed document
// or a fixed error, and records whether it was called.
type fakeTokenSource struct {
	file    work.CredentialFile
	err     error
	fetched int
}

func (f *fakeTokenSource) SandboxCredentialFile(context.Context) (work.CredentialFile, error) {
	f.fetched++
	return f.file, f.err
}

// --- harness ---------------------------------------------------------------

func template() work.SandboxTemplate {
	return work.SandboxTemplate{
		Image:           "ghcr.io/example/sandbox:v1",
		CPURequest:      "2",
		MemoryLimit:     "8Gi",
		DeadlineSeconds: int64((12 * time.Hour).Seconds()),
		Env:             map[string]string{"CODEX_HOME": "/work/.codex"},
	}
}

func deps() Deps {
	return Deps{
		GitHub:          &fakeGitHub{},
		Pods:            &fakePods{},
		Repo:            &fakeRepo{},
		Stages:          &fakeStages{},
		Transcripts:     &fakeTranscript{},
		Prompts:         &fakePrompts{},
		Status:          &fakeStatus{},
		Runs:            &fakeRuns{},
		Sweeper:         &fakeSweeper{},
		Metrics:         &fakeMetrics{},
		DispatcherState: &fakeDispatcherState{},
		TokenSource:     &fakeTokenSource{},
		Log:             slog.New(slog.NewTextHandler(io.Discard, nil)),
		Clock:           clocktest.NewFake(time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)),
		Sandbox:         template(),
		RepoURL:         "https://github.com/0x63616c/world-wide-webb.git",
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
	for _, name := range []string{
		"GitHub", "Pods", "Repo", "Stages", "Transcripts", "Prompts", "Status", "Runs", "Sweeper", "Metrics",
		"DispatcherState", "TokenSource", "Clock", "Log",
	} {
		if !strings.Contains(err.Error(), name) {
			t.Fatalf("error %q does not name the missing %s", err, name)
		}
	}
}

func TestNewRefusesASandboxTemplateItCannotBuildAPodFrom(t *testing.T) {
	t.Parallel()

	d := deps()
	d.Sandbox.Image = ""

	if _, err := New(d); !errors.Is(err, work.ErrInvalidRun) {
		t.Fatalf("an imageless template must fail construction, got %v", err)
	}
}

// sandboxDeps builds a complete SandboxDeps, the way deps() does for Deps.
func sandboxDeps() SandboxDeps {
	return SandboxDeps{
		Stages:      &fakeStages{},
		Transcripts: &fakeTranscript{},
		Prompts:     &fakePrompts{},
		Metrics:     &fakeMetrics{},
		Log:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		Clock:       clocktest.NewFake(time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)),
	}
}

// TestNewSandboxSideNamesEveryDependencyItIsMissing is NewSandboxSide's half
// of TestNewNamesEveryDependencyItIsMissing: a narrower constructor still owes
// the same "no usable-but-invalid zero value" guarantee, over a narrower set
// of fields.
func TestNewSandboxSideNamesEveryDependencyItIsMissing(t *testing.T) {
	t.Parallel()

	_, err := NewSandboxSide(SandboxDeps{})
	if err == nil {
		t.Fatal("a sandbox-side activity set with no dependencies must not construct")
	}
	for _, name := range []string{"Stages", "Transcripts", "Prompts", "Metrics", "Log", "Clock"} {
		if !strings.Contains(err.Error(), name) {
			t.Fatalf("error %q does not name the missing %s", err, name)
		}
	}
}

// TestNewSandboxSideBuildsAWorkingRunPlan proves the narrower constructor
// actually wires the stage-running activities end to end, not merely that it
// type-checks: a SandboxDeps missing something RunPlan silently never touched
// would still pass the missing-dependency test above.
func TestNewSandboxSideBuildsAWorkingRunPlan(t *testing.T) {
	t.Parallel()

	a, err := NewSandboxSide(sandboxDeps())
	if err != nil {
		t.Fatalf("NewSandboxSide: %v", err)
	}

	e := env(t)
	e.RegisterActivity(a.RunPlan)
	if _, err := e.ExecuteActivity(a.RunPlan, stageAttempt(work.PriorTurns{})); err != nil {
		t.Fatalf("RunPlan on a sandbox-side Activities: %v", err)
	}
}

func TestNewRefusesToConstructWithNoRepositoryToClone(t *testing.T) {
	t.Parallel()

	d := deps()
	d.RepoURL = ""

	_, err := New(d)
	if err == nil {
		t.Fatal("a set of activities with no RepoURL must not construct")
	}
	if !strings.Contains(err.Error(), "RepoURL") {
		t.Fatalf("error %q does not name the missing RepoURL", err)
	}
}

// --- github activities -----------------------------------------------------

func TestAutoLabelPresentReturnsThePointReadResult(t *testing.T) {
	t.Parallel()

	gh := &fakeGitHub{autoLabelPresent: true}
	d := deps()
	d.GitHub = gh
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.AutoLabelPresent)

	val, err := e.ExecuteActivity(a.AutoLabelPresent, 328)
	if err != nil {
		t.Fatalf("AutoLabelPresent: %v", err)
	}

	var present bool
	if err := val.Get(&present); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !present {
		t.Fatal("a current auto label must be returned to the dispatcher")
	}
}

func TestAutoLabelPresentSurfacesAnAuthFailureAsTheTypeThatPausesTheDispatcher(t *testing.T) {
	t.Parallel()

	gh := &fakeGitHub{autoLabelErr: fmt.Errorf("reading: %w (%w): %w", github.ErrAuth, work.ErrPermanent, errors.New("403"))}
	d := deps()
	d.GitHub = gh
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.AutoLabelPresent)

	_, err := e.ExecuteActivity(a.AutoLabelPresent, 328)
	if err == nil {
		t.Fatal("an auth failure must fail the activity")
	}
	if got := FailureKindOf(err); got != work.FailureAuth {
		t.Fatalf("FailureKindOf = %q, want %q — this is what pauses the dispatcher", got, work.FailureAuth)
	}
}

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

func TestLabelFailureMarksTheIssueAndItsPullRequest(t *testing.T) {
	t.Parallel()

	gh := &fakeGitHub{}
	d := deps()
	d.GitHub = gh
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.LabelFailure)

	if _, err := e.ExecuteActivity(a.LabelFailure, LabelFailureInput{TicketNumber: 328, PullRequestNumber: 9}); err != nil {
		t.Fatalf("LabelFailure: %v", err)
	}
	if got, want := fmt.Sprint(gh.failed), "[328 9]"; got != want {
		t.Fatalf("marked %s, want %s", got, want)
	}
}

func TestLabelFailureMarksOnlyTheIssueBeforeAPullRequestExists(t *testing.T) {
	t.Parallel()

	gh := &fakeGitHub{}
	d := deps()
	d.GitHub = gh
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.LabelFailure)

	if _, err := e.ExecuteActivity(a.LabelFailure, LabelFailureInput{TicketNumber: 328}); err != nil {
		t.Fatalf("LabelFailure: %v", err)
	}
	if got, want := fmt.Sprint(gh.failed), "[328]"; got != want {
		t.Fatalf("marked %s, want %s", got, want)
	}
}

func TestLabelFailurePreservesTheGitHubFailureKind(t *testing.T) {
	t.Parallel()

	gh := &fakeGitHub{failedErr: fmt.Errorf("labelling: %w (%w): %w", github.ErrAuth, work.ErrPermanent, errors.New("403"))}
	d := deps()
	d.GitHub = gh
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.LabelFailure)

	_, err := e.ExecuteActivity(a.LabelFailure, LabelFailureInput{TicketNumber: 328, PullRequestNumber: 9})
	if err == nil {
		t.Fatal("an auth failure must fail the activity")
	}
	if got := FailureKindOf(err); got != work.FailureAuth {
		t.Fatalf("FailureKindOf = %q, want %q", got, work.FailureAuth)
	}
	if !strings.Contains(err.Error(), "issue #328") {
		t.Fatalf("error %q does not identify the failed target", err)
	}
	if got, want := fmt.Sprint(gh.failed), "[328]"; got != want {
		t.Fatalf("marked %s, want %s after the first target fails", got, want)
	}
}

func TestRejectDuplicateWorkflowIDPostsBeforeClearingAuto(t *testing.T) {
	t.Parallel()

	gh := &fakeGitHub{}
	status := &fakeStatus{}
	d := deps()
	d.GitHub, d.Status = gh, status
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.RejectDuplicateWorkflowID)

	in := work.DuplicateWorkflowExecution{TicketNumber: 328, WorkflowID: "work-ticket-328", RunID: "run-1"}
	if _, err := e.ExecuteActivity(a.RejectDuplicateWorkflowID, in); err != nil {
		t.Fatalf("RejectDuplicateWorkflowID: %v", err)
	}
	if status.sawRejection != in || gh.postedTo != 328 || gh.postedBody != "duplicate workflow notice" {
		t.Fatalf("rendered %+v and posted #%d %q, want %+v / #328 / duplicate notice", status.sawRejection, gh.postedTo, gh.postedBody, in)
	}
	if len(gh.cleared) != 1 || gh.cleared[0] != 328 {
		t.Fatalf("cleared %v, want [328] after posting the notice", gh.cleared)
	}
}

// --- sandbox lifecycle -----------------------------------------------------

func TestCreateSandboxRefusesAPodDeadlineTheRunCanOutlive(t *testing.T) {
	t.Parallel()

	tokens := &fakeTokenSource{}
	d := deps()
	d.Sandbox.DeadlineSeconds = 60
	d.TokenSource = tokens
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.CreateSandbox)

	_, err := e.ExecuteActivity(a.CreateSandbox, CreateSandboxInput{
		TicketNumber: 1, RunID: "run-1", RunTimeout: 5 * time.Hour,
	})
	if err == nil {
		t.Fatal("Kubernetes must never be able to kill a pod Temporal still believes in")
	}
	if d.Pods.(*fakePods).created != nil {
		t.Fatal("the pod must not have been created at all")
	}
	if tokens.fetched != 0 {
		t.Fatal("the credential must not be fetched for a deadline that was refused before it")
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
		TicketNumber: 328, RunID: "run-1", RunTimeout: 5 * time.Hour,
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
	if spec.Image != template().Image || spec.CPURequest != template().CPURequest {
		t.Fatalf("spec did not come from the template: %+v", spec)
	}
}

func TestCreateSandboxFetchesTheCredentialAndPassesItToPodsCreate(t *testing.T) {
	t.Parallel()

	doc := work.NewCredentialFile([]byte(`{"tokens":{"access_token":"t"}}`))
	pods := &fakePods{}
	tokens := &fakeTokenSource{file: doc}
	d := deps()
	d.Pods, d.TokenSource = pods, tokens
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.CreateSandbox)

	if _, err := e.ExecuteActivity(a.CreateSandbox, CreateSandboxInput{
		TicketNumber: 328, RunID: "run-1", RunTimeout: 5 * time.Hour,
	}); err != nil {
		t.Fatalf("CreateSandbox: %v", err)
	}

	if tokens.fetched != 1 {
		t.Fatalf("fetched the credential %d times, want 1", tokens.fetched)
	}
	if len(pods.sawCredent) != 1 || string(pods.sawCredent[0].Reveal()) != string(doc.Reveal()) {
		t.Fatalf("Pods.Create did not receive the document TokenSource yielded: %+v", pods.sawCredent)
	}
	// CreateSandboxInput above is this activity's whole recorded input — the
	// credential must never reach it (#434 D3, acceptance criterion 5).
}

func TestCreateSandboxFailsLoudlyWhenTheCredentialCannotBeFetched(t *testing.T) {
	t.Parallel()

	pods := &fakePods{}
	tokens := &fakeTokenSource{err: permanent(codexauth.ErrUnseeded)}
	d := deps()
	d.Pods, d.TokenSource = pods, tokens
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.CreateSandbox)

	_, err := e.ExecuteActivity(a.CreateSandbox, CreateSandboxInput{
		TicketNumber: 328, RunID: "run-1", RunTimeout: 5 * time.Hour,
	})
	if err == nil {
		t.Fatal("an unseeded credential must fail CreateSandbox before any pod is created")
	}
	if pods.created != nil {
		t.Fatal("the pod must not be created without a credential to seal into its Secret")
	}
	if got := FailureKindOf(err); got != work.FailureAuth {
		t.Fatalf("FailureKindOf = %q, want %q — a missing codex-auth secret must pause the dispatcher, not spin", got, work.FailureAuth)
	}
}

func TestCreateSandboxTellsTheSandboxWhichBranchToPush(t *testing.T) {
	t.Parallel()

	pods := &fakePods{}
	d := deps()
	d.Pods = pods
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.CreateSandbox)

	if _, err := e.ExecuteActivity(a.CreateSandbox, CreateSandboxInput{
		TicketNumber: 328, RunID: "run-1", RunTimeout: 5 * time.Hour,
	}); err != nil {
		t.Fatalf("CreateSandbox: %v", err)
	}

	// The same branch the worker will later ask GitHub about. A sandbox that
	// pushed somewhere else would produce a pull request nothing can find, and
	// every run would report itself blocked having done the work.
	want := work.BranchName(328, "run-1")
	if got := pods.created[0].Env[work.SandboxBranchEnv]; got != want {
		t.Fatalf("%s = %q, want %q", work.SandboxBranchEnv, got, want)
	}
	if _, kept := pods.created[0].Env["CODEX_HOME"]; !kept {
		t.Fatal("the template's own environment must survive")
	}
}

func TestCreateSandboxTellsTheSandboxWhichBranchToPushOnTheTicketBackedPipeline(t *testing.T) {
	t.Parallel()

	// #603: CreateSandbox is the one activity both pipelines share, so
	// TicketBacked is what has to steer SF_BRANCH toward
	// FactoryTicketBranchName's branch instead of BranchName's — the branch
	// factoryImplementReviewLoop actually asks GitHub about. Getting this wrong
	// is exactly how the Ticket-backed pipeline's first production run failed
	// to open a pull request: `implement` pushed one branch and the workflow
	// asked GitHub about another, and GitHub rejected the head ref outright.
	pods := &fakePods{}
	d := deps()
	d.Pods = pods
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.CreateSandbox)

	if _, err := e.ExecuteActivity(a.CreateSandbox, CreateSandboxInput{
		TicketNumber: 1, RunID: "run-1", RunTimeout: 5 * time.Hour, TicketBacked: true,
	}); err != nil {
		t.Fatalf("CreateSandbox: %v", err)
	}

	want := work.FactoryTicketBranchName(1, "run-1")
	if got := pods.created[0].Env[work.SandboxBranchEnv]; got != want {
		t.Fatalf("%s = %q, want %q (the Ticket-backed branch, not %q)",
			work.SandboxBranchEnv, got, want, work.BranchName(1, "run-1"))
	}
}

// --- clone -------------------------------------------------------------

func TestCloneRepoMintsACredentialAndPassesItToTheCloner(t *testing.T) {
	t.Parallel()

	repo := &fakeRepo{}
	d := deps()
	d.Repo = repo
	d.RepoURL = "https://github.com/0x63616c/world-wide-webb.git"
	d.GitHub = &fakeGitHub{token: work.SandboxCredential{Token: work.NewCredential("ghs_topsecret"), Login: "www-software-factory-bot[bot]", AccountID: 309464436}}
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.CloneRepo)

	if _, err := e.ExecuteActivity(a.CloneRepo, work.SandboxID("sandbox-328")); err != nil {
		t.Fatalf("CloneRepo: %v", err)
	}

	if repo.called != 1 {
		t.Fatalf("called the cloner %d times, want 1", repo.called)
	}
	if repo.sawSandbox != "sandbox-328" {
		t.Fatalf("cloned into sandbox %q, want sandbox-328", repo.sawSandbox)
	}
	if repo.sawURL != d.RepoURL {
		t.Fatalf("cloned %q, want the configured repository url %q", repo.sawURL, d.RepoURL)
	}
	if repo.sawToken != "ghs_topsecret" {
		t.Fatalf("the cloner did not receive the minted credential")
	}
	// The login travels with the token, because gh in the sandbox cannot ask
	// GitHub who an installation token belongs to and refuses to run without an
	// answer (#414). A cloner that received the token alone would write a
	// hosts.yml gh fails on before every command.
	if repo.sawLogin != "www-software-factory-bot[bot]" {
		t.Fatalf("the cloner received login %q, want the bot identity minted alongside the token", repo.sawLogin)
	}
	if repo.sawAccountID != 309464436 {
		t.Fatalf("the cloner received account ID %d, want 309464436", repo.sawAccountID)
	}
}

func TestCloneRepoFailsLoudlyWhenTheCredentialCannotBeMinted(t *testing.T) {
	t.Parallel()

	repo := &fakeRepo{}
	d := deps()
	d.Repo = repo
	d.GitHub = &fakeGitHub{tokenErr: github.ErrAuth}
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.CloneRepo)

	if _, err := e.ExecuteActivity(a.CloneRepo, work.SandboxID("sandbox-328")); err == nil {
		t.Fatal("CloneRepo succeeded despite a credential mint failure")
	}
	if repo.called != 0 {
		t.Fatal("the cloner must not be called without a credential to hand it")
	}
}

func TestCloneRepoSurfacesTheClonersFailure(t *testing.T) {
	t.Parallel()

	repo := &fakeRepo{err: fmt.Errorf("sandbox does not have SF_BRANCH set: %w", work.ErrPermanent)}
	d := deps()
	d.Repo = repo
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.CloneRepo)

	_, err := e.ExecuteActivity(a.CloneRepo, work.SandboxID("sandbox-328"))
	if err == nil {
		t.Fatal("CloneRepo succeeded despite the cloner failing")
	}
	if !strings.Contains(err.Error(), "SF_BRANCH") {
		t.Fatalf("error %q lost the cloner's reason", err)
	}
}

// --- stages ----------------------------------------------------------------

// stageAttempt builds a plan attempt's input for tests exercising the shared
// runStage plumbing — plan stands in for "any stage" throughout this file
// except where a test is specifically about implement's or review's own
// decoded shape, which build a RunImplementInput/RunReviewInput directly.
func stageAttempt(prior work.PriorTurns) RunPlanInput {
	return NewRunPlanInput(StageAttempt{
		Key:     work.StageKey{Ticket: 328, RunID: "run-1", Stage: work.StagePlan, Turn: 1},
		Sandbox: "sandbox-328",
		Model:   work.Model{Name: "gpt-5.6-terra", Effort: "medium"},
		Detail:  work.TicketDetail{Ticket: work.Ticket{Number: 328, Title: "t", Body: "b"}},
		Prior:   prior,
	})
}

func TestRunPlanWritesOneTerminatedLinePerEventToTheTranscript(t *testing.T) {
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
	e.RegisterActivity(a.RunPlan)

	if _, err := e.ExecuteActivity(a.RunPlan, stageAttempt(work.PriorTurns{})); err != nil {
		t.Fatalf("RunPlan: %v", err)
	}

	want := `{"type":"turn.started"}` + "\n" + `{"type":"turn.completed"}` + "\n"
	if got := transcript.buf.String(); got != want {
		t.Fatalf("transcript = %q, want %q — framing has exactly one owner", got, want)
	}
	if !transcript.closed.Load() {
		t.Fatal("the transcript must be closed")
	}
}

// TestRunPlanCarriesTheWholeTranscriptHomeOnItsOutput proves D5 (#434): a
// successful stage's whole event stream travels back on the activity's own
// output, not only into the sandbox's own local sink, so a later
// PersistTranscript activity on the main queue has something to relay.
func TestRunPlanCarriesTheWholeTranscriptHomeOnItsOutput(t *testing.T) {
	t.Parallel()

	transcript := &fakeTranscript{}
	stages := &fakeStages{
		events: [][]byte{[]byte(`{"type":"turn.started"}`), []byte(`{"type":"turn.completed"}`)},
		result: work.StageResult{Output: []byte(`{"ok":true}`)},
	}
	d := deps()
	d.Transcripts, d.Stages = transcript, stages
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.RunPlan)

	val, err := e.ExecuteActivity(a.RunPlan, stageAttempt(work.PriorTurns{}))
	if err != nil {
		t.Fatalf("RunPlan: %v", err)
	}

	var out RunPlanOutput
	if err := val.Get(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	want := `{"type":"turn.started"}` + "\n" + `{"type":"turn.completed"}` + "\n"
	if string(out.Transcript) != want {
		t.Fatalf("out.Transcript = %q, want %q — exactly what the local sink received", string(out.Transcript), want)
	}
	// The local sink still received every byte too: the capture is a mirror,
	// not a replacement for it.
	if transcript.buf.String() != want {
		t.Fatalf("the local sink = %q, want the same bytes", transcript.buf.String())
	}
}

func TestRunPlanHeartbeatsOffTheEventStreamSoAStuckStageIsSeenAsDeadRatherThanSlow(t *testing.T) {
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
			e.RegisterActivity(a.RunPlan)

			if _, err := e.ExecuteActivity(a.RunPlan, stageAttempt(work.PriorTurns{})); err != nil {
				t.Fatalf("RunPlan: %v", err)
			}

			if got := beats.Load() > 0; got != c.wantBeat {
				t.Fatalf("heartbeated = %v (%d beats), want %v", got, beats.Load(), c.wantBeat)
			}
		})
	}
}

func TestRunPlanKeepsGoingWhenTheTranscriptCannotBeWritten(t *testing.T) {
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
	e.RegisterActivity(a.RunPlan)

	val, err := e.ExecuteActivity(a.RunPlan, stageAttempt(work.PriorTurns{}))
	if err != nil {
		t.Fatalf("losing the record of the work is cheaper than losing the work: %v", err)
	}

	var out RunPlanOutput
	if err := val.Get(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if string(out.Output) != `{"ok":true}` {
		t.Fatalf("output = %q, want the stage's own result", out.Output)
	}
}

func TestRunPlanClosesTheTranscriptWhenTheStageFails(t *testing.T) {
	t.Parallel()

	transcript := &fakeTranscript{}
	d := deps()
	d.Transcripts = transcript
	d.Stages = &fakeStages{err: errors.New("exit 1")}
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.RunPlan)

	_, err := e.ExecuteActivity(a.RunPlan, stageAttempt(work.PriorTurns{}))
	if err == nil {
		t.Fatal("a failed stage fails its activity")
	}
	// Asserts the real cause, not just that some error came back — a nil
	// *RunPlanOutput on this path is what stops the SDK's own encode attempt
	// silently replacing it with an unrelated marshalling error (#457's whole
	// point; that gap is exactly how the defect shipped unnoticed the first
	// time, in RunStage before this activity replaced it).
	if !strings.Contains(err.Error(), "exit 1") {
		t.Fatalf("error = %v, want the stage's own failure (\"exit 1\"), not an unrelated encode error", err)
	}
	if !transcript.closed.Load() {
		t.Fatal("a failed stage's transcript is the one most worth reading, so it must still be closed")
	}
}

func TestRunImplementHandsEveryPriorTurnToTheRenderer(t *testing.T) {
	t.Parallel()

	prompts := &fakePrompts{prompt: "do the thing", schema: []byte(`{"type":"object"}`)}
	stages := &fakeStages{}
	d := deps()
	d.Prompts, d.Stages = prompts, stages
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.RunImplement)

	prior := work.PriorTurns{
		Plan:            work.NewStageOutput(work.StagePlan, work.DocumentOutput{Document: "the plan"}),
		LatestImplement: work.NewStageOutput(work.StageImplement, work.ImplementOutput{Report: "turn one's report"}),
	}
	in := NewRunImplementInput(StageAttempt{
		Key:     work.StageKey{Ticket: 328, RunID: "run-1", Stage: work.StageImplement, Turn: 2},
		Sandbox: "sandbox-328",
		Model:   work.Model{Name: "gpt-5.6-terra", Effort: "medium"},
		Detail:  work.TicketDetail{Ticket: work.Ticket{Number: 328, Title: "t", Body: "b"}},
		Prior:   prior,
	})
	if _, err := e.ExecuteActivity(a.RunImplement, in); err != nil {
		t.Fatalf("RunImplement: %v", err)
	}

	// Both fields the loop narrows to, not only the plan: buildStageInput
	// reads the plan and implement's own previous turn, and a seam that
	// carried only one could not render either at once.
	if prompts.sawStage != work.StageImplement {
		t.Fatalf("renderer saw stage %q", prompts.sawStage)
	}
	// The WHOLE key, not only its stage: review's prompt is rendered with the
	// turn number in it ("turn 2 of 3"), so a seam that dropped Turn would
	// render every review turn as turn zero and no other test would notice.
	if want := (work.StageKey{Ticket: 328, RunID: "run-1", Stage: work.StageImplement, Turn: 2}); prompts.sawKey != want {
		t.Fatalf("renderer saw key %+v, want %+v", prompts.sawKey, want)
	}
	if prompts.sawPrior.Plan.Prose() != "the plan" {
		t.Fatalf("renderer saw prior plan %q, want %q", prompts.sawPrior.Plan.Prose(), "the plan")
	}
	if prompts.sawPrior.LatestImplement.Prose() != "turn one's report" {
		t.Fatalf("renderer saw prior implement report %q, want %q", prompts.sawPrior.LatestImplement.Prose(), "turn one's report")
	}
	if stages.sawRun.Prompt != "do the thing" || string(stages.sawRun.Schema) != `{"type":"object"}` {
		t.Fatalf("the rendered prompt and schema must reach the stage runner, got %+v", stages.sawRun)
	}
}

// TestRunImplementCarriesBlockedFields proves Blocked/BlockedReason survive
// from the decoded envelope through to the activity's own result, on the
// concrete work.ImplementOutput type — not merely as prose folded into the
// document plan answers in.
func TestRunImplementCarriesBlockedFields(t *testing.T) {
	t.Parallel()

	d := deps()
	d.Prompts = &fakePrompts{decode: func(stage work.Stage, _ []byte) (work.StageOutput, error) {
		return work.NewStageOutput(stage, work.ImplementOutput{
			Report: "did the work", Blocked: true, BlockedReason: "needs a human",
		}), nil
	}}
	d.Stages = &fakeStages{result: work.StageResult{
		Output: []byte(`{"report":"did the work","blocked":true,"blocked_reason":"needs a human","title":"","body":""}`),
	}}
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.RunImplement)

	in := NewRunImplementInput(StageAttempt{
		Key:     work.StageKey{Ticket: 328, RunID: "run-1", Stage: work.StageImplement, Turn: 1},
		Sandbox: "sandbox-328",
		Model:   work.Model{Name: "gpt-5.6-terra", Effort: "medium"},
		Detail:  work.TicketDetail{Ticket: work.Ticket{Number: 328, Title: "t", Body: "b"}},
	})
	val, err := e.ExecuteActivity(a.RunImplement, in)
	if err != nil {
		t.Fatalf("RunImplement: %v", err)
	}

	var out RunImplementOutput
	if err := val.Get(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	got, ok := out.Result.Value().(work.ImplementOutput)
	if !ok {
		t.Fatalf("Result.Value() = %T, want work.ImplementOutput", out.Result.Value())
	}
	if !got.Blocked || got.BlockedReason != "needs a human" {
		t.Fatalf("Blocked/BlockedReason did not survive to the activity's output: %+v", got)
	}
}

// TestRunReviewCarriesFindings proves Findings survive from the decoded
// envelope through to the activity's own result, on the concrete
// work.ReviewOutput type.
func TestRunReviewCarriesFindings(t *testing.T) {
	t.Parallel()

	d := deps()
	d.Prompts = &fakePrompts{decode: func(stage work.Stage, _ []byte) (work.StageOutput, error) {
		return work.NewStageOutput(stage, work.ReviewOutput{
			Document: "found one blocking issue",
			Findings: []work.Finding{{ID: "f1", Blocking: true, Summary: "missing nil check"}},
		}), nil
	}}
	d.Stages = &fakeStages{result: work.StageResult{
		Output: []byte(`{"document":"found one blocking issue","findings":[{"id":"f1","blocking":true,"summary":"missing nil check"}]}`),
	}}
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.RunReview)

	in := NewRunReviewInput(StageAttempt{
		Key:     work.StageKey{Ticket: 328, RunID: "run-1", Stage: work.StageReview, Turn: 1},
		Sandbox: "sandbox-328",
		Model:   work.Model{Name: "gpt-5.6-terra", Effort: "medium"},
		Detail:  work.TicketDetail{Ticket: work.Ticket{Number: 328, Title: "t", Body: "b"}},
	})
	val, err := e.ExecuteActivity(a.RunReview, in)
	if err != nil {
		t.Fatalf("RunReview: %v", err)
	}

	var out RunReviewOutput
	if err := val.Get(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	got, ok := out.Result.Value().(work.ReviewOutput)
	if !ok {
		t.Fatalf("Result.Value() = %T, want work.ReviewOutput", out.Result.Value())
	}
	if len(got.Findings) != 1 || got.Findings[0].ID != "f1" {
		t.Fatalf("Findings did not survive to the activity's output: %+v", got)
	}
}

func TestRunPlanDoesNotStartTheStageWhenTheTranscriptCannotBeOpened(t *testing.T) {
	t.Parallel()

	stages := &fakeStages{}
	d := deps()
	d.Transcripts = &fakeTranscript{openErr: errors.New("no such volume")}
	d.Stages = stages
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.RunPlan)

	if _, err := e.ExecuteActivity(a.RunPlan, stageAttempt(work.PriorTurns{})); err == nil {
		t.Fatal("an unopenable transcript fails the stage")
	}
	if stages.ranOnce {
		t.Fatal("tokens must not be spent on a stage whose record cannot be kept")
	}
}

// --- transcript relay --------------------------------------------------

func TestPersistTranscriptWritesTheWholeDocumentThroughTheDurableSink(t *testing.T) {
	t.Parallel()

	sink := &fakeTranscript{}
	d := deps()
	d.Transcripts = sink
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.PersistTranscript)

	key := work.StageKey{Ticket: 328, RunID: "run-1", Stage: work.StagePlan}
	transcript := work.Transcript(`{"type":"turn.started"}` + "\n")
	if _, err := e.ExecuteActivity(a.PersistTranscript, PersistTranscriptInput{Key: key, Transcript: transcript}); err != nil {
		t.Fatalf("PersistTranscript: %v", err)
	}

	if sink.buf.String() != string(transcript) {
		t.Fatalf("durable sink = %q, want %q", sink.buf.String(), string(transcript))
	}
	if !sink.closed.Load() {
		t.Fatal("the durable transcript must be closed")
	}
}

func TestPersistTranscriptFailsLoudlyWhenTheDurableSinkCannotBeOpened(t *testing.T) {
	t.Parallel()

	sink := &fakeTranscript{openErr: errors.New("no such volume")}
	d := deps()
	d.Transcripts = sink
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.PersistTranscript)

	key := work.StageKey{Ticket: 328, RunID: "run-1", Stage: work.StagePlan}
	_, err := e.ExecuteActivity(a.PersistTranscript, PersistTranscriptInput{Key: key, Transcript: work.Transcript("x")})
	if err == nil {
		t.Fatal("an unopenable durable sink must fail the activity")
	}
}

func TestPersistTranscriptFailsLoudlyWhenTheWriteItselfFails(t *testing.T) {
	t.Parallel()

	sink := &fakeTranscript{writeErr: errors.New("volume full")}
	d := deps()
	d.Transcripts = sink
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.PersistTranscript)

	key := work.StageKey{Ticket: 328, RunID: "run-1", Stage: work.StagePlan}
	_, err := e.ExecuteActivity(a.PersistTranscript, PersistTranscriptInput{Key: key, Transcript: work.Transcript("x")})
	if err == nil {
		t.Fatal("a write failure against the durable sink must fail the activity — unlike RunStage's own local write, there is no in-memory copy of this record left anywhere else")
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

func TestRunPlanRecordsWhatASuccessfulStageSpent(t *testing.T) {
	t.Parallel()

	metrics := &fakeMetrics{}
	d := deps()
	d.Metrics = metrics
	d.Stages = &fakeStages{result: work.StageResult{
		Output: []byte(`{"ok":true}`),
		Usage:  work.Usage{InputTokens: 100, CachedInputTokens: 40, OutputTokens: 20, ReasoningTokens: 5},
	}}
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.RunPlan)

	if _, err := e.ExecuteActivity(a.RunPlan, stageAttempt(work.PriorTurns{})); err != nil {
		t.Fatalf("RunPlan: %v", err)
	}

	if len(metrics.outcomes) != 1 || metrics.outcomes[0] != telemetry.OutcomeSuccess {
		t.Fatalf("recorded %v, want one success", metrics.outcomes)
	}
	// The nesting is the provider's and is passed through untouched: input
	// includes cached, and reasoning is a subset of output. Pre-subtracting here
	// would double-count every cache hit in the metric that does the split.
	if got := metrics.usages[0]; got.InputTokens != 100 || got.CachedInputTokens != 40 || got.ReasoningTokens != 5 {
		t.Fatalf("usage = %+v, want the provider's own nesting preserved", got)
	}
}

func TestRunPlanRecordsAFailedStageToo(t *testing.T) {
	t.Parallel()

	metrics := &fakeMetrics{}
	d := deps()
	d.Metrics = metrics
	d.Stages = &fakeStages{
		result: work.StageResult{Usage: work.Usage{InputTokens: 100}},
		err:    permanent(github.ErrAuth),
	}
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.RunPlan)

	if _, err := e.ExecuteActivity(a.RunPlan, stageAttempt(work.PriorTurns{})); err == nil {
		t.Fatal("a failed stage fails its activity")
	}

	if len(metrics.outcomes) != 1 {
		t.Fatalf("recorded %v — a stage that failed spent its tokens too, and a metric that counts only "+
			"successes makes the expensive case the invisible one", metrics.outcomes)
	}
	if metrics.outcomes[0] != telemetry.OutcomeAuthFailed {
		t.Fatalf("outcome = %q, want %q", metrics.outcomes[0], telemetry.OutcomeAuthFailed)
	}
	if metrics.usages[0].InputTokens != 100 {
		t.Fatalf("usage = %+v, want the tokens the failed attempt spent", metrics.usages[0])
	}
}

func TestFindPullRequestAsksAboutTheBranchItWasGiven(t *testing.T) {
	t.Parallel()

	gh := &fakeGitHub{pr: work.PullRequest{Number: 9, URL: "https://github.com/o/r/pull/9"}, prFound: true}
	d := deps()
	d.GitHub = gh
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.FindPullRequest)

	branch := work.BranchName(328, "run-1")
	val, err := e.ExecuteActivity(a.FindPullRequest, branch)
	if err != nil {
		t.Fatalf("FindPullRequest: %v", err)
	}

	var out FindPullRequestOutput
	if err := val.Get(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if gh.askedBranch != branch {
		t.Fatalf("asked about %q, want %q", gh.askedBranch, branch)
	}
	if !out.Found || out.PullRequest.URL != "https://github.com/o/r/pull/9" {
		t.Fatalf("out = %+v, want the pull request GitHub reported", out)
	}
}

func TestFindPullRequestReportsAbsenceAsAnAnswerNotAnError(t *testing.T) {
	t.Parallel()

	d := deps()
	d.GitHub = &fakeGitHub{prFound: false}
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.FindPullRequest)

	val, err := e.ExecuteActivity(a.FindPullRequest, work.BranchName(328, "run-1"))
	if err != nil {
		t.Fatalf("a run that opened no pull request is blocked, not broken: %v", err)
	}

	var out FindPullRequestOutput
	if err := val.Get(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Found {
		t.Fatal("nothing was found")
	}
}

func TestOpenOrUpdatePullRequestPassesThePushThroughToGitHub(t *testing.T) {
	t.Parallel()

	gh := &fakeGitHub{openOrUpdatePR: work.PullRequest{Number: 9, URL: "https://github.com/o/r/pull/9", NodeID: "PR_9"}}
	d := deps()
	d.GitHub = gh
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.OpenOrUpdatePullRequest)

	existing := &work.PullRequest{Number: 9, NodeID: "PR_9", Title: "old", Body: "old body"}
	val, err := e.ExecuteActivity(a.OpenOrUpdatePullRequest, OpenOrUpdatePullRequestInput{
		Branch: "software-factory/ticket-328/run-1", Title: "new", Body: "new body", Existing: existing,
	})
	if err != nil {
		t.Fatalf("OpenOrUpdatePullRequest: %v", err)
	}

	var out work.PullRequest
	if err := val.Get(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Number != 9 || out.NodeID != "PR_9" {
		t.Fatalf("out = %+v, want what the client returned", out)
	}
	if gh.openOrUpdateInput.branch != "software-factory/ticket-328/run-1" || gh.openOrUpdateInput.title != "new" || gh.openOrUpdateInput.body != "new body" {
		t.Fatalf("gh saw %+v, want the input passed through unchanged", gh.openOrUpdateInput)
	}
	// Value, not pointer identity: ExecuteActivity round-trips the input
	// through Temporal's real data converter even in this in-memory test
	// environment, so the *work.PullRequest the fake records can never be the
	// same pointer the test constructed. What the claim actually is — "the
	// activity forwards the existing pull request unchanged" — is a value
	// claim, and that is what this asserts.
	if gh.openOrUpdateInput.existing == nil || *gh.openOrUpdateInput.existing != *existing {
		t.Fatalf("existing = %+v, want %+v passed through unchanged — the workflow's own FindPullRequest lookup would be looked up a second time",
			gh.openOrUpdateInput.existing, existing)
	}
}

func TestOpenOrUpdatePullRequestFailsTheActivityWhenGitHubDoes(t *testing.T) {
	t.Parallel()

	d := deps()
	d.GitHub = &fakeGitHub{openOrUpdateErr: github.ErrInvalid}
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.OpenOrUpdatePullRequest)

	if _, err := e.ExecuteActivity(a.OpenOrUpdatePullRequest, OpenOrUpdatePullRequestInput{Branch: "b", Title: "t", Body: "d"}); err == nil {
		t.Fatal("want an error when the github client refuses to open or update the pull request")
	}
}

func TestConvertPullRequestToDraftPassesTheNodeIDThrough(t *testing.T) {
	t.Parallel()

	gh := &fakeGitHub{}
	d := deps()
	d.GitHub = gh
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.ConvertPullRequestToDraft)

	if _, err := e.ExecuteActivity(a.ConvertPullRequestToDraft, "PR_kwDOtest9"); err != nil {
		t.Fatalf("ConvertPullRequestToDraft: %v", err)
	}
	if gh.draftedNodeID != "PR_kwDOtest9" {
		t.Fatalf("drafted node id = %q, want PR_kwDOtest9", gh.draftedNodeID)
	}
}

func TestConvertPullRequestToDraftFailsTheActivityWhenGitHubDoes(t *testing.T) {
	t.Parallel()

	d := deps()
	d.GitHub = &fakeGitHub{draftErr: github.ErrAuth}
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.ConvertPullRequestToDraft)

	// This is the one activity in this service whose caller (ticketRun.decline)
	// must turn a failure into the workflow's own error rather than log and
	// continue — see internal/workflows/terminal.go. That decision reads the
	// error this activity returns, so the activity itself must actually fail
	// rather than swallow the client's error.
	if _, err := e.ExecuteActivity(a.ConvertPullRequestToDraft, "PR_1"); err == nil {
		t.Fatal("want an error when the github client cannot convert the pull request to draft")
	}
}

func TestMarkPullRequestReadyForReviewPassesTheNodeIDThrough(t *testing.T) {
	t.Parallel()

	gh := &fakeGitHub{}
	d := deps()
	d.GitHub = gh
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.MarkPullRequestReadyForReview)

	if _, err := e.ExecuteActivity(a.MarkPullRequestReadyForReview, "PR_kwDOtest9"); err != nil {
		t.Fatalf("MarkPullRequestReadyForReview: %v", err)
	}
	if gh.readyNodeID != "PR_kwDOtest9" {
		t.Fatalf("ready node id = %q, want PR_kwDOtest9", gh.readyNodeID)
	}
}

func TestMarkPullRequestReadyForReviewFailsTheActivityWhenGitHubDoes(t *testing.T) {
	t.Parallel()

	d := deps()
	d.GitHub = &fakeGitHub{readyErr: github.ErrAuth}
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.MarkPullRequestReadyForReview)

	if _, err := e.ExecuteActivity(a.MarkPullRequestReadyForReview, "PR_1"); err == nil {
		t.Fatal("want an error when the github client cannot mark the pull request ready")
	}
}

func TestEnablePullRequestAutoMergePassesTheNodeIDThrough(t *testing.T) {
	t.Parallel()

	gh := &fakeGitHub{}
	d := deps()
	d.GitHub = gh
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.EnablePullRequestAutoMerge)

	if _, err := e.ExecuteActivity(a.EnablePullRequestAutoMerge, "PR_kwDOtest9"); err != nil {
		t.Fatalf("EnablePullRequestAutoMerge: %v", err)
	}
	if gh.autoMergeNodeID != "PR_kwDOtest9" {
		t.Fatalf("auto-merge node id = %q, want PR_kwDOtest9", gh.autoMergeNodeID)
	}
}

func TestEnablePullRequestAutoMergeFailsTheActivityWhenGitHubDoes(t *testing.T) {
	t.Parallel()

	d := deps()
	d.GitHub = &fakeGitHub{autoMergeErr: github.ErrAuth}
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.EnablePullRequestAutoMerge)

	if _, err := e.ExecuteActivity(a.EnablePullRequestAutoMerge, "PR_1"); err == nil {
		t.Fatal("want an error when the github client cannot enable auto-merge")
	}
}

func TestPostPullRequestCommentReusesPostStatusAgainstThePullRequestNumber(t *testing.T) {
	t.Parallel()

	gh := &fakeGitHub{}
	d := deps()
	d.GitHub = gh
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.PostPullRequestComment)

	if _, err := e.ExecuteActivity(a.PostPullRequestComment, 42, "the full decline detail"); err != nil {
		t.Fatalf("PostPullRequestComment: %v", err)
	}
	if gh.postedTo != 42 || gh.postedBody != "the full decline detail" {
		t.Fatalf("posted to %d with %q, want #42 with the given body", gh.postedTo, gh.postedBody)
	}
}

func TestRunPlanReturnsTheDocumentInsideTheEnvelopeNotTheEnvelope(t *testing.T) {
	t.Parallel()

	// The next stage's prompt is rendered from the document, and A1's envelope
	// is `{"document": ...}`. Handing the raw envelope on would interpolate
	// JSON into a prompt where prose belongs, and every downstream stage would
	// read a wrapper it was never shown the shape of.
	envelope := []byte(`{"document":"the plan itself"}`)
	d := deps()
	d.Stages = &fakeStages{result: work.StageResult{Output: envelope}}
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.RunPlan)

	val, err := e.ExecuteActivity(a.RunPlan, stageAttempt(work.PriorTurns{}))
	if err != nil {
		t.Fatalf("RunPlan: %v", err)
	}

	var out RunPlanOutput
	if err := val.Get(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Result.Prose() != "document of "+string(envelope) {
		t.Fatalf("Result.Prose() = %q — it must come from the seam that owns the envelope format", out.Result.Prose())
	}
	if string(out.Output) != string(envelope) {
		t.Fatalf("Output = %q, want the raw envelope kept for the transcript", out.Output)
	}
}

func TestRunPlanFailsWhenTheEnvelopeCannotBeRead(t *testing.T) {
	t.Parallel()

	d := deps()
	d.Prompts = &fakePrompts{decodeErr: errors.New("no document field")}
	d.Stages = &fakeStages{result: work.StageResult{Output: []byte(`{"nonsense":1}`)}}
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.RunPlan)

	if _, err := e.ExecuteActivity(a.RunPlan, stageAttempt(work.PriorTurns{})); err == nil {
		t.Fatal("a stage that answered in some other shape has not done its job; carrying an empty document " +
			"into the next prompt would hide that")
	}
}

// TestRunPlanOutputRefusesThePreThisStepShape covers the real migration path,
// which is the activity *result* decode and not StageOutput.UnmarshalJSON.
//
// Before step 4 (#443) the result carried `Document string`; it now carries
// `Result work.StageOutput`. That is a rename, so a pre-deploy payload has no
// "Result" key at all and StageOutput.UnmarshalJSON is never reached — plain
// encoding/json, which is exactly what the SDK's JSONPayloadConverter runs,
// would drop the unrecognised "Document" and hand back a zero Result with no
// error. A run in flight across the deploy would then replay as though the
// completed stage had produced nothing, and fail later somewhere unrelated
// (buildStageInput's missing-prior check) instead of here, where the mismatch
// is. stageOutputUnmarshalJSON, shared by RunPlanOutput/RunImplementOutput/
// RunReviewOutput since this step's activity split (#435), is what makes it
// fail here.
func TestRunPlanOutputRefusesThePreThisStepShape(t *testing.T) {
	t.Parallel()

	// The literal shape a pre-this-step RunStage activity result was written
	// to history as: no json struct tags on the type, so bare Go field names.
	old := []byte(`{"Output":"e30=","Document":"the plan itself","ThreadID":"thread_1",` +
		`"Usage":{"InputTokens":1,"OutputTokens":2}}`)

	payload, err := converter.GetDefaultDataConverter().ToPayload(json.RawMessage(old))
	if err != nil {
		t.Fatalf("building the payload: %v", err)
	}

	var out RunPlanOutput
	err = converter.GetDefaultDataConverter().FromPayload(payload, &out)
	if err == nil {
		t.Fatalf("decoding a pre-this-step result must fail loudly; it produced Result.Prose() = %q, "+
			"which would replay as though the stage produced nothing", out.Result.Prose())
	}
	if !strings.Contains(err.Error(), "Document") {
		t.Fatalf("the error must name the field that no longer exists, got: %v", err)
	}
}

// --- RecordDispatcherState --------------------------------------------------

func TestRecordDispatcherStateWritesWhatItWasGiven(t *testing.T) {
	t.Parallel()

	writer := &fakeDispatcherState{}
	d := deps()
	d.DispatcherState = writer
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.RecordDispatcherState)

	config := work.DefaultConfig()
	config.Paused = true
	in := store.DispatcherState{
		Config:     config,
		InFlight:   []work.InFlightTicket{{Ticket: 551, RunID: "run-1"}},
		Candidates: []int{552, 553},
		FreeSlots:  1,
	}

	if _, err := e.ExecuteActivity(a.RecordDispatcherState, in); err != nil {
		t.Fatalf("RecordDispatcherState: %v", err)
	}
	if writer.puts != 1 {
		t.Fatalf("PutDispatcherState calls = %d, want 1", writer.puts)
	}
	if !writer.written.Config.Paused {
		t.Fatal("the store did not receive the config the activity was given")
	}
	if len(writer.written.Candidates) != 2 || writer.written.Candidates[0] != 552 {
		t.Fatalf("the store did not receive the candidates the activity was given, got %v", writer.written.Candidates)
	}
}

// TestRecordDispatcherStateSurfacesAWriteFailure proves a database outage is
// reported rather than swallowed — the dispatcher workflow (#551) decides
// what to do with it, but the activity must not hide it.
func TestRecordDispatcherStateSurfacesAWriteFailure(t *testing.T) {
	t.Parallel()

	writer := &fakeDispatcherState{err: errors.New("connection refused")}
	d := deps()
	d.DispatcherState = writer
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.RecordDispatcherState)

	_, err := e.ExecuteActivity(a.RecordDispatcherState, store.DispatcherState{})
	if err == nil {
		t.Fatal("a store write failure must fail the activity")
	}
	if !strings.Contains(err.Error(), "recording dispatcher state") {
		t.Fatalf("error %q does not name the operation", err)
	}
}
