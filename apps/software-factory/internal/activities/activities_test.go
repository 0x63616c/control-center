package activities

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/github"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock/clocktest"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/testsuite"
)

// --- fakes -----------------------------------------------------------------

type fakeGitHub struct {
	postErr error

	postedTo   int
	postedBody string

	pr          work.PullRequest
	prFound     bool
	prErr       error
	askedBranch string

	token      work.SandboxCredential
	tokens     []work.SandboxCredential
	tokenErr   error
	tokenCalls int

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

	mergeNumber      int
	mergeExpectedSHA string
	mergeResult      work.PullRequestMergeResult
	mergeErr         error
}

func (f *fakeGitHub) PostComment(_ context.Context, number int, body string) error {
	f.postedTo, f.postedBody = number, body
	return f.postErr
}

func (f *fakeGitHub) InstallationToken(context.Context) (work.SandboxCredential, error) {
	f.tokenCalls++
	if len(f.tokens) >= f.tokenCalls {
		return f.tokens[f.tokenCalls-1], f.tokenErr
	}
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

func (f *fakeGitHub) ChecksForCommit(ctx context.Context, commitSHA string, _ []string) ([]work.CheckRun, error) {
	return f.ChecksForRef(ctx, commitSHA)
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

func (f *fakeGitHub) MergePullRequest(_ context.Context, number int, expectedHeadSHA string) (work.PullRequestMergeResult, error) {
	f.mergeNumber, f.mergeExpectedSHA = number, expectedHeadSHA
	return f.mergeResult, f.mergeErr
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
	operations   []string
	tokens       []string
	err          error
}

func (f *fakeRepo) CloneRepo(_ context.Context, sandbox work.SandboxID, cloneURL string, credential work.SandboxCredential) error {
	f.called++
	f.operations = append(f.operations, "clone")
	f.tokens = append(f.tokens, credential.Token.Reveal())
	f.sawSandbox, f.sawURL, f.sawToken = sandbox, cloneURL, credential.Token.Reveal()
	f.sawLogin = credential.Login
	f.sawAccountID = credential.AccountID
	return f.err
}

func (f *fakeRepo) PushRepo(_ context.Context, sandbox work.SandboxID, cloneURL string, credential work.SandboxCredential) error {
	f.called++
	f.operations = append(f.operations, "push")
	f.tokens = append(f.tokens, credential.Token.Reveal())
	f.sawSandbox, f.sawURL, f.sawToken = sandbox, cloneURL, credential.Token.Reveal()
	f.sawLogin = credential.Login
	f.sawAccountID = credential.AccountID
	return f.err
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
		Runs:            &fakeRuns{},
		Sweeper:         &fakeSweeper{},
		DispatcherState: &fakeDispatcherState{},
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
		"GitHub", "Pods", "Repo", "Runs", "Sweeper",
		"DispatcherState", "Clock", "Log",
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

// --- sandbox lifecycle -----------------------------------------------------

func TestCreateSandboxRefusesAPodDeadlineTheRunCanOutlive(t *testing.T) {
	t.Parallel()

	d := deps()
	d.Sandbox.DeadlineSeconds = 60
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
	// pushed somewhere else would produce a pull request nothing can find —
	// which is #603, where the two computations disagreed and GitHub rejected
	// the head ref outright.
	want := work.FactoryTicketBranchName(328, "run-1")
	if got := pods.created[0].Env[work.SandboxBranchEnv]; got != want {
		t.Fatalf("%s = %q, want %q", work.SandboxBranchEnv, got, want)
	}
	if _, kept := pods.created[0].Env["CODEX_HOME"]; !kept {
		t.Fatal("the template's own environment must survive")
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

func TestPushRepoMintsANewCredentialAfterClone(t *testing.T) {
	t.Parallel()

	repo := &fakeRepo{}
	githubClient := &fakeGitHub{tokens: []work.SandboxCredential{
		{Token: work.NewCredential("clone-token"), Login: "factory[bot]", AccountID: 1},
		{Token: work.NewCredential("push-token"), Login: "factory[bot]", AccountID: 1},
	}}
	d := deps()
	d.Repo = repo
	d.GitHub = githubClient
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.CloneRepo)
	e.RegisterActivity(a.PushRepo)

	if _, err := e.ExecuteActivity(a.CloneRepo, work.SandboxID("sandbox-328")); err != nil {
		t.Fatalf("CloneRepo: %v", err)
	}
	if _, err := e.ExecuteActivity(a.PushRepo, work.SandboxID("sandbox-328")); err != nil {
		t.Fatalf("PushRepo: %v", err)
	}

	if githubClient.tokenCalls != 2 {
		t.Fatalf("installation token calls = %d, want one for clone and a fresh one for push", githubClient.tokenCalls)
	}
	if got, want := strings.Join(repo.operations, ","), "clone,push"; got != want {
		t.Fatalf("repository operations = %q, want %q", got, want)
	}
	if got, want := strings.Join(repo.tokens, ","), "clone-token,push-token"; got != want {
		t.Fatalf("repository credentials = %q, want %q", got, want)
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

	val, err := e.ExecuteActivity(a.DescribeRun, work.FactoryTicketWorkflowID(328))
	if err != nil {
		t.Fatalf("DescribeRun: %v", err)
	}

	var state work.RunState
	if err := val.Get(&state); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if runs.saw != "factory-ticket-328" || !state.Open || state.RunID != "run-9" {
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

func TestMergePullRequestPassesTheNumberAndReviewedHeadThrough(t *testing.T) {
	t.Parallel()

	gh := &fakeGitHub{mergeResult: work.PullRequestMergeResult{
		Outcome:  work.PullRequestMergeConfirmed,
		MergeSHA: "merge-sha",
	}}
	d := deps()
	d.GitHub = gh
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.MergePullRequest)

	var result work.PullRequestMergeResult
	value, err := e.ExecuteActivity(a.MergePullRequest, MergePullRequestInput{PullRequestNumber: 9, ExpectedHeadSHA: "reviewed-head"})
	if err != nil {
		t.Fatalf("executing MergePullRequest: %v", err)
	}
	if err := value.Get(&result); err != nil {
		t.Fatalf("MergePullRequest: %v", err)
	}
	if gh.mergeNumber != 9 || gh.mergeExpectedSHA != "reviewed-head" {
		t.Fatalf("merge input = #%d at %q, want #9 at reviewed-head", gh.mergeNumber, gh.mergeExpectedSHA)
	}
	if result.Outcome != work.PullRequestMergeConfirmed || result.MergeSHA != "merge-sha" {
		t.Fatalf("result = %+v, want confirmed merge-sha", result)
	}
}

func TestMergePullRequestPreservesTheGitHubRetryTaxonomy(t *testing.T) {
	t.Parallel()

	d := deps()
	d.GitHub = &fakeGitHub{mergeErr: permanent(github.ErrAuth)}
	a := mustNew(t, d)

	_, err := a.MergePullRequest(t.Context(), MergePullRequestInput{PullRequestNumber: 9, ExpectedHeadSHA: "reviewed-head"})
	app := appErrorOf(t, err)
	if app.Type() != ErrTypeAuth || !app.NonRetryable() {
		t.Fatalf("merge error = type %q non-retryable %v, want permanent auth classification", app.Type(), app.NonRetryable())
	}
}

func TestMergePullRequestKeepsRepositoryPolicyRetryableForOperatorRepair(t *testing.T) {
	t.Parallel()

	d := deps()
	d.GitHub = &fakeGitHub{mergeErr: fmt.Errorf("review required: %w", github.ErrRuleset)}
	a := mustNew(t, d)

	_, err := a.MergePullRequest(t.Context(), MergePullRequestInput{PullRequestNumber: 9, ExpectedHeadSHA: "reviewed-head"})
	app := appErrorOf(t, err)
	if app.Type() != ErrTypeRuleset || app.NonRetryable() {
		t.Fatalf("merge error = type %q non-retryable %v, want retryable ruleset classification", app.Type(), app.NonRetryable())
	}
}

func TestPostPullRequestCommentPostsAgainstThePullRequestNumber(t *testing.T) {
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
