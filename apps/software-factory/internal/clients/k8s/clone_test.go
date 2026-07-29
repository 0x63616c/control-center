package k8s

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	utilexec "k8s.io/client-go/util/exec"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

const (
	testCloneURL = "https://github.com/0x63616c/world-wide-webb.git"
	testBranch   = "software-factory/ticket-328/3f1c2a7e"
)

// notARepo is what `git rev-parse` answers when work.RepoDir holds nothing
// usable — absent, empty, or present but not a repository. Real git exits 128
// for all three; the exact code does not matter to currentBranch, only that it
// is non-zero.
var notARepo = answer{err: utilexec.CodeExitError{Err: errors.New("fatal: not a git repository"), Code: 128}}

func TestCloneRepoFailsLoudlyWhenSFBranchIsNotSet(t *testing.T) {
	t.Parallel()

	// printenv exits 1 and prints nothing when the variable is unset.
	str := &scriptedStreamer{answers: []answer{
		{err: utilexec.CodeExitError{Err: errors.New("printenv: SF_BRANCH: not found"), Code: 1}},
	}}
	s, _ := newTestSandboxes(t, str, runningPod())

	err := s.CloneRepo(context.Background(), testSandbox, testCloneURL, work.NewCredential("t"))
	if err == nil {
		t.Fatal("CloneRepo succeeded with no SF_BRANCH in the sandbox's environment")
	}
	if !errors.Is(err, work.ErrPermanent) {
		t.Fatal("a missing SF_BRANCH is a configuration bug, not a moment worth retrying")
	}
	if !strings.Contains(err.Error(), work.SandboxBranchEnv) {
		t.Fatalf("error %q does not name %s", err, work.SandboxBranchEnv)
	}

	// Nothing else may run: no credential may be written, nothing cloned, and
	// no branch pushed, when there is no branch to check out at all.
	if calls := str.observed(); len(calls) != 1 {
		t.Fatalf("issued %d exec calls after refusing, want exactly the printenv probe: %+v", len(calls), calls)
	}
}

func TestCloneRepoFailsLoudlyWhenSFBranchIsEmpty(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{{stdout: "\n"}}}
	s, _ := newTestSandboxes(t, str, runningPod())

	err := s.CloneRepo(context.Background(), testSandbox, testCloneURL, work.NewCredential("t"))
	if err == nil {
		t.Fatal("CloneRepo succeeded with SF_BRANCH set but empty")
	}
	if !errors.Is(err, work.ErrPermanent) {
		t.Fatal("an empty SF_BRANCH is a configuration bug, not a moment worth retrying")
	}
	if !strings.Contains(err.Error(), work.SandboxBranchEnv) {
		t.Fatalf("error %q does not name %s", err, work.SandboxBranchEnv)
	}
}

func TestCloneRepoRefusesWithNoRepositoryURL(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{}
	s, _ := newTestSandboxes(t, str, runningPod())

	err := s.CloneRepo(context.Background(), testSandbox, "", work.NewCredential("t"))
	if !errors.Is(err, work.ErrPermanent) {
		t.Fatalf("CloneRepo with no repository url = %v, want a permanent error", err)
	}
	if len(str.observed()) != 0 {
		t.Fatal("nothing should be execed in the sandbox before the url is even checked")
	}
}

func TestCloneRepoClonesChecksOutAndPushesAFreshSandbox(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{
		{stdout: testBranch + "\n"}, // printenv SF_BRANCH
		{},                          // tar -xf (writeCredentials)
		{},                          // tar -xf (writeGhCredentials)
		notARepo,                    // git rev-parse (no existing checkout)
		{},                          // rm -rf (clear whatever is there)
		{},                          // git clone
		{},                          // git checkout -b
		{},                          // git config --local credential.helper
		{},                          // git push -u origin
	}}
	s, _ := newTestSandboxes(t, str, runningPod())

	if err := s.CloneRepo(context.Background(), testSandbox, testCloneURL, work.NewCredential("ghs_secret")); err != nil {
		t.Fatalf("CloneRepo: %v", err)
	}

	calls := str.observed()
	if len(calls) != 9 {
		t.Fatalf("issued %d exec calls, want 9: %+v", len(calls), calls)
	}

	if got := realArgv(calls[0].argv); len(got) != 2 || got[0] != "printenv" || got[1] != work.SandboxBranchEnv {
		t.Fatalf("call 0 = %v, want printenv %s", got, work.SandboxBranchEnv)
	}

	// The credential file is written as a tar body, never as an argv word —
	// decodeTar reads exactly what a real `tar -xf` extraction would see.
	entries := decodeTar(t, calls[1].stdin)
	if len(entries) != 1 || entries[0].name != strings.TrimPrefix(credentialsPath, "/") {
		t.Fatalf("credential write entries = %+v, want one entry at %s", entries, credentialsPath)
	}
	if entries[0].mode != 0o600 {
		t.Fatalf("credential file mode = %o, want 0600", entries[0].mode)
	}
	if !strings.Contains(entries[0].body, "x-access-token:ghs_secret@github.com") {
		t.Fatalf("credential file body = %q, does not carry the minted token", entries[0].body)
	}

	// gh's own credential file, carrying the same token in gh's format because
	// gh cannot read git's (#414). Same transport, same mode: a token that
	// reached the pod as an argv word or an environment entry would be readable
	// from the pod spec and from anything that logged the exec.
	// Two entries, not one: GhConfigDir does not exist in the pod — /work is an
	// emptyDir and gh's config directory is not the credential file's parent
	// the way SandboxRoot is for .git-credentials — so the tar body has to
	// carry the directory ahead of the file or the extraction fails.
	ghEntries := decodeTar(t, calls[2].stdin)
	if len(ghEntries) != 2 {
		t.Fatalf("gh credential write entries = %+v, want the config directory then the file", ghEntries)
	}
	if ghEntries[0].name != strings.TrimPrefix(work.GhConfigDir, "/")+"/" {
		t.Fatalf("gh credential write entry 0 = %q, want the %s directory", ghEntries[0].name, work.GhConfigDir)
	}
	hosts := ghEntries[1]
	if hosts.name != strings.TrimPrefix(work.GhHostsFile, "/") {
		t.Fatalf("gh credential write entry 1 = %q, want %s", hosts.name, work.GhHostsFile)
	}
	if hosts.mode != 0o600 {
		t.Fatalf("gh credential file mode = %o, want 0600", hosts.mode)
	}
	if !strings.Contains(hosts.body, "oauth_token: ghs_secret") {
		t.Fatalf("gh credential file body = %q, does not carry the minted token", hosts.body)
	}

	if got := realArgv(calls[3].argv); len(got) < 2 || got[0] != "git" || got[len(got)-1] != "HEAD" {
		t.Fatalf("call 3 = %v, want the rev-parse probe", got)
	}
	if got := realArgv(calls[4].argv); len(got) != 4 || got[0] != "rm" || got[3] != work.RepoDir {
		t.Fatalf("call 4 = %v, want rm -rf -- %s", got, work.RepoDir)
	}

	clone := realArgv(calls[5].argv)
	if clone[0] != "git" || clone[len(clone)-2] != testCloneURL || clone[len(clone)-1] != work.RepoDir {
		t.Fatalf("clone argv = %v, want git ... clone %s %s", clone, testCloneURL, work.RepoDir)
	}
	if !containsArg(clone, credentialHelper) {
		t.Fatalf("clone argv = %v, did not configure the credential helper", clone)
	}
	for _, word := range clone {
		if strings.Contains(word, "ghs_secret") {
			t.Fatalf("clone argv %v carries the credential itself, not just its file path", clone)
		}
	}

	checkout := realArgv(calls[6].argv)
	if checkout[len(checkout)-2] != "-b" || checkout[len(checkout)-1] != testBranch {
		t.Fatalf("checkout argv = %v, want checkout -b %s", checkout, testBranch)
	}

	// This is the fix: the checkout's own git config, not just this package's
	// own commands, is what implement's later BARE `git push` — no -c of its
	// own — resolves a credential through.
	config := realArgv(calls[7].argv)
	if want := []string{"git", "-C", work.RepoDir, "config", "--local", "credential.helper", credentialHelperValue}; !equalArgv(config, want) {
		t.Fatalf("config argv = %v, want %v", config, want)
	}

	// And the proof that it worked: this package's OWN push, issued after
	// configureCredentialHelper, carries no `-c` of its own — the same shape
	// implement's bare `git push -u origin HEAD` takes.
	push := realArgv(calls[8].argv)
	if want := []string{"git", "-C", work.RepoDir, "push", "-u", "origin", testBranch}; !equalArgv(push, want) {
		t.Fatalf("push argv = %v, want %v (no -c: it must authenticate through the checkout's own config)", push, want)
	}

	// The credential file must never be removed: implement pushes from inside
	// the sandbox, as the model, long after CloneRepo has returned, and it has
	// nothing else to authenticate with.
	for _, c := range calls {
		argv := realArgv(c.argv)
		if len(argv) >= 2 && argv[0] == "rm" && containsArg(argv, credentialsPath) {
			t.Fatalf("removed the credential file: %v — implement's own push has nothing left to authenticate with", argv)
		}
	}
}

func TestCloneRepoLeavesAnExistingCheckoutOnTheRunsBranchAloneButPushesAnyway(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{
		{stdout: testBranch + "\n"}, // printenv SF_BRANCH
		{},                          // tar -xf (writeCredentials)
		{},                          // tar -xf (writeGhCredentials)
		{stdout: testBranch + "\n"}, // git rev-parse: already on this run's branch
		{},                          // git config --local credential.helper
		{},                          // git push -u origin
	}}
	s, _ := newTestSandboxes(t, str, runningPod())

	if err := s.CloneRepo(context.Background(), testSandbox, testCloneURL, work.NewCredential("t")); err != nil {
		t.Fatalf("CloneRepo: %v", err)
	}

	calls := str.observed()
	if len(calls) != 6 {
		t.Fatalf("issued %d exec calls, want 6 — no clone, no checkout: %+v", len(calls), calls)
	}
	for _, c := range calls {
		argv := realArgv(c.argv)
		if len(argv) > 0 && argv[0] == "git" && containsArg(argv, "clone") {
			t.Fatalf("re-cloned an existing checkout: %v", argv)
		}
	}
	// The credential helper is reconfigured even when the checkout is reused,
	// so a retry that resumes an old attempt's checkout is not depending on
	// that attempt having got as far as configuring it.
	config := realArgv(calls[4].argv)
	if config[len(config)-1] != credentialHelperValue {
		t.Fatalf("config argv = %v, want it to (re)configure the credential helper", config)
	}
	push := realArgv(calls[5].argv)
	if push[len(push)-1] != testBranch {
		t.Fatalf("push argv = %v, want it to still push the branch", push)
	}
}

func TestCloneRepoRefusesAnExistingCheckoutOnTheWrongBranch(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{
		{stdout: testBranch + "\n"},         // printenv SF_BRANCH
		{},                                  // tar -xf (writeCredentials)
		{},                                  // tar -xf (writeGhCredentials)
		{stdout: "somebody-elses-branch\n"}, // git rev-parse: a DIFFERENT checkout
	}}
	s, _ := newTestSandboxes(t, str, runningPod())

	err := s.CloneRepo(context.Background(), testSandbox, testCloneURL, work.NewCredential("t"))
	if err == nil {
		t.Fatal("CloneRepo succeeded despite an existing checkout on a different branch")
	}
	if !errors.Is(err, work.ErrPermanent) {
		t.Fatal("switching a checkout out from under whatever is there is never the safe default")
	}
	if !strings.Contains(err.Error(), testBranch) || !strings.Contains(err.Error(), "somebody-elses-branch") {
		t.Fatalf("error %q does not name both branches", err)
	}

	calls := str.observed()
	if len(calls) != 4 {
		t.Fatalf("issued %d exec calls, want exactly 4 (no clone, no checkout, no config, no push): %+v", len(calls), calls)
	}
}

func TestCloneRepoSurfacesAGitFailureWithoutMarkingItPermanent(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{
		{stdout: testBranch + "\n"}, // printenv SF_BRANCH
		{},                          // tar -xf (writeCredentials)
		{},                          // tar -xf (writeGhCredentials)
		notARepo,                    // git rev-parse (no existing checkout)
		{},                          // rm -rf
		{err: utilexec.CodeExitError{Err: errors.New("fatal: unable to access"), Code: 128}}, // git clone fails
	}}
	s, _ := newTestSandboxes(t, str, runningPod())

	err := s.CloneRepo(context.Background(), testSandbox, testCloneURL, work.NewCredential("t"))
	if err == nil {
		t.Fatal("CloneRepo succeeded despite git clone exiting 128")
	}
	if errors.Is(err, work.ErrPermanent) {
		t.Fatalf("a clone that failed with an ordinary git exit code was marked permanent, which stops it ever being retried: %v", err)
	}
}

// TestCloneRepoLeavesTheCredentialFileAndItsCheckoutConfigInPlaceOnFailure
// pins the "never remove it" half of the fix independently of the happy-path
// assertion above: even a run that never gets as far as a working checkout
// must not have deleted a credential file a RETRY, or a human debugging the
// pod, could still use.
func TestCloneRepoLeavesTheCredentialFileAndItsCheckoutConfigInPlaceOnFailure(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{
		{stdout: testBranch + "\n"},         // printenv SF_BRANCH
		{},                                  // tar -xf (writeCredentials)
		{},                                  // tar -xf (writeGhCredentials)
		{stdout: "somebody-elses-branch\n"}, // git rev-parse: a DIFFERENT checkout — CloneRepo refuses
	}}
	s, _ := newTestSandboxes(t, str, runningPod())

	if err := s.CloneRepo(context.Background(), testSandbox, testCloneURL, work.NewCredential("t")); err == nil {
		t.Fatal("expected the wrong-branch refusal")
	}

	for _, c := range str.observed() {
		argv := realArgv(c.argv)
		if len(argv) > 0 && argv[0] == "rm" {
			t.Fatalf("a failed CloneRepo removed something: %v — nothing here may clean up the credential file", argv)
		}
	}
}

// TestACheckoutConfiguredThisWayResolvesACredentialForABarePush is the test
// the coordinator's review asked for: a version of this package that wrote
// the credential file but never persisted `credential.helper` into the
// checkout — the original bug — would pass every scripted test above if they
// only inspected argv, because CloneRepo's OWN push always carried its own
// `-c`. What implement's later push actually depends on is not that argv; it
// is whether a BARE git command, run from inside the checkout with no `-c` of
// its own, can still resolve a credential. This proves that against a real
// git binary and a real local checkout — no k8s, no fakes — using exactly the
// file format writeCredentials produces (credentialLine) and exactly the
// config value configureCredentialHelper writes (credentialHelperValue's
// format, "store --file=<path>").
//
// It is why this test could not have been satisfied by inspecting this
// package's own argv, which is what the earlier version of this fix got
// wrong: nothing here cares what CloneRepo passed on its own command line,
// only what the checkout's config resolves to for a command that passes
// nothing at all.
func TestACheckoutConfiguredThisWayResolvesACredentialForABarePush(t *testing.T) {
	t.Parallel()

	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available on this machine")
	}

	dir := t.TempDir()
	credPath := filepath.Join(dir, "git-credentials")
	repoDir := filepath.Join(dir, "repo")

	const token = "ghs_realproof"
	if err := os.WriteFile(credPath, []byte(credentialLine(work.NewCredential(token))), 0o600); err != nil {
		t.Fatalf("writing the credential file: %v", err)
	}

	if err := os.MkdirAll(repoDir, 0o755); err != nil {
		t.Fatalf("making the checkout dir: %v", err)
	}
	runGit(t, repoDir, "init")

	// The exact value configureCredentialHelper writes, just against a real
	// temp path instead of work.RepoDir's production one — "store
	// --file=<path>" is git-credential-store(1)'s own config grammar, the same
	// grammar credentialHelperValue is built from.
	runGit(t, repoDir, "config", "--local", "credential.helper", "store --file="+credPath)

	// A BARE `git credential fill`: no -c, nothing on this command line at all
	// beyond the subcommand itself — the same shape implement.md's `git push
	// -u origin HEAD` takes. If it resolves the credential, so would that push.
	cmd := hermeticGit(dir, "credential", "fill")
	cmd.Dir = repoDir
	cmd.Stdin = strings.NewReader("protocol=https\nhost=github.com\n\n")
	var out, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("git credential fill (bare, no -c): %v\nstderr: %s", err, stderr.String())
	}

	got := out.String()
	if !strings.Contains(got, "username=x-access-token") {
		t.Fatal("bare credential fill did not resolve the expected username — implement's own push would not authenticate")
	}
	if !strings.Contains(got, "password="+token) {
		t.Fatal("bare credential fill did not resolve the expected password — implement's own push would not authenticate")
	}
	// Deliberately not logging `got` on failure above: it is exactly a
	// git-credential-fill response, which on a developer machine with its own
	// ambient credential helpers configured can resolve to a REAL, live
	// credential rather than this test's fixture — see hermeticGit's doc for
	// why every invocation in this test is isolated from that ambient config,
	// and why this assertion still checks contents without ever printing them.
}

// runGit runs a hermetic git invocation in dir and fails the test with
// stderr on a non-zero exit.
func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := hermeticGit(dir, args...)
	cmd.Dir = dir
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("git %v: %v\nstderr: %s", args, err, stderr.String())
	}
}

// hermeticGit builds a git invocation that cannot see this machine's own git
// configuration or credential helpers.
//
// This test proves a REAL git resolves a credential through nothing but the
// checkout's own --local config — but "real git" on a developer's machine
// also has its own global/system config, which routinely names a real
// credential helper (a keychain, gh's own helper, a cached token) for
// github.com. Without this isolation, `git credential fill` for
// protocol=https host=github.com does not necessarily answer from this test's
// fixture at all: git merges every configured helper and the last one to
// answer wins, so it can just as easily hand back whatever real credential is
// sitting in the machine running the test — which happened during this fix's
// own development and is why this function exists. GIT_CONFIG_GLOBAL and
// GIT_CONFIG_SYSTEM pointed at nothing, plus a HOME confined to the test's
// own temp dir, are what make the --local config this test wrote the only
// place git can look.
func hermeticGit(home string, args ...string) *exec.Cmd {
	cmd := exec.Command("git", args...)
	cmd.Env = append(os.Environ(),
		"HOME="+home,
		"XDG_CONFIG_HOME="+home,
		"GIT_CONFIG_GLOBAL="+os.DevNull,
		"GIT_CONFIG_SYSTEM="+os.DevNull,
		"GIT_TERMINAL_PROMPT=0",
	)
	return cmd
}

// equalArgv compares two argv slices element-wise, so a mismatch fails with
// the whole of both sides rather than reflect.DeepEqual's opaque bool.
func equalArgv(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

// realArgv strips the sandbox-exec shim prefix ("sandbox-exec --pidfile P
// --") that every exec call carries, leaving the argv this file actually
// asked to run.
func realArgv(argv []string) []string {
	for i, w := range argv {
		if w == "--" {
			return argv[i+1:]
		}
	}
	return argv
}

// containsArg reports whether argv holds word as one of its elements.
func containsArg(argv []string, word string) bool {
	for _, w := range argv {
		if w == word {
			return true
		}
	}
	return false
}
