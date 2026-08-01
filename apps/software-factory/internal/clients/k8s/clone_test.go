package k8s

import (
	"context"
	"errors"
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

// testBotLogin is the shape of what GitHub names a GitHub App's identity: its
// slug with a "[bot]" suffix. The brackets are the point — they are what a
// value naively used as a path segment or an unquoted YAML scalar would break
// on.
const testBotLogin = "www-software-factory-bot[bot]"

const testBotAccountID = int64(309464436)

// testCredential is what InstallationToken hands CloneRepo: a token and the
// login gh must be told to attribute it to.
func testCredential(token string) work.SandboxCredential {
	return work.SandboxCredential{Token: work.NewCredential(token), Login: testBotLogin, AccountID: testBotAccountID}
}

func TestCloneRepoFailsLoudlyWhenSFBranchIsNotSet(t *testing.T) {
	t.Parallel()

	// printenv exits 1 and prints nothing when the variable is unset.
	str := &scriptedStreamer{answers: []answer{
		{err: utilexec.CodeExitError{Err: errors.New("printenv: SF_BRANCH: not found"), Code: 1}},
	}}
	s, _ := newTestSandboxes(t, str, runningPod())

	err := s.CloneRepo(context.Background(), testSandbox, testCloneURL, testCredential("t"))
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

	err := s.CloneRepo(context.Background(), testSandbox, testCloneURL, testCredential("t"))
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

	err := s.CloneRepo(context.Background(), testSandbox, "", testCredential("t"))
	if !errors.Is(err, work.ErrPermanent) {
		t.Fatalf("CloneRepo with no repository url = %v, want a permanent error", err)
	}
	if len(str.observed()) != 0 {
		t.Fatal("nothing should be execed in the sandbox before the url is even checked")
	}
}

func TestPushRepoPublishesFromAConfigIsolatedPrivateRepository(t *testing.T) {
	t.Parallel()

	const privateDir = "/tmp/software-factory-push.ABCDEFGH"
	str := &scriptedStreamer{answers: []answer{
		{stdout: testBranch + "\n"}, // printenv SF_BRANCH
		{},                          // tar -xf (writeCredentials)
		{stdout: testBranch + "\n"}, // verify the checkout branch
		{stdout: privateDir + "\n"}, // mktemp -d
		{},                          // git bundle create
		{},                          // git init --bare
		{},                          // git fetch from the bundle
		{},                          // git push from private bare repo
		{},                          // rm -rf private directory
	}}
	s, _ := newTestSandboxes(t, str, runningPod())

	if err := s.PushRepo(context.Background(), testSandbox, testCloneURL, testCredential("ghs_fresh")); err != nil {
		t.Fatalf("PushRepo: %v", err)
	}

	calls := str.observed()
	if len(calls) != 9 {
		t.Fatalf("issued %d exec calls, want 9: %+v", len(calls), calls)
	}
	for i, call := range calls {
		if call.target.container != repositoryContainerName {
			t.Fatalf("call %d targeted container %q, want credentialed repository sidecar %q", i, call.target.container, repositoryContainerName)
		}
	}

	bundlePath := privateDir + "/source.bundle"
	privateRepo := privateDir + "/repository.git"
	wantBundle := []string{
		"env", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null", "GIT_CONFIG_NOSYSTEM=1",
		"git", "-c", "core.hooksPath=/dev/null", "-C", work.RepoDir,
		"bundle", "create", bundlePath, "HEAD",
	}
	if got := realArgv(calls[4].argv); !equalArgv(got, wantBundle) {
		t.Fatalf("bundle argv = %v, want %v", got, wantBundle)
	}

	wantInit := []string{
		"env", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null", "GIT_CONFIG_NOSYSTEM=1",
		"git", "-c", "core.hooksPath=/dev/null", "init", "--bare", privateRepo,
	}
	if got := realArgv(calls[5].argv); !equalArgv(got, wantInit) {
		t.Fatalf("init argv = %v, want %v", got, wantInit)
	}

	wantFetch := []string{
		"env", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null", "GIT_CONFIG_NOSYSTEM=1",
		"git", "-c", "core.hooksPath=/dev/null", "-C", privateRepo,
		"fetch", "--no-tags", "--force", "--", bundlePath, "HEAD:refs/heads/publish",
	}
	if got := realArgv(calls[6].argv); !equalArgv(got, wantFetch) {
		t.Fatalf("fetch argv = %v, want %v", got, wantFetch)
	}

	wantPush := []string{
		"env", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0",
		"git", "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", credentialHelper,
		"-C", privateRepo, "push", "--", testCloneURL,
		"refs/heads/publish:refs/heads/" + testBranch,
	}
	if got := realArgv(calls[7].argv); !equalArgv(got, wantPush) {
		t.Fatalf("push argv = %v, want %v", got, wantPush)
	}
	if containsArg(calls[7].argv, work.RepoDir) || containsArg(calls[7].argv, "origin") {
		t.Fatalf("push trusts the shared checkout or its remote: %v", calls[7].argv)
	}
	for _, word := range calls[7].argv {
		if strings.Contains(word, "ghs_fresh") {
			t.Fatalf("push argv carries the token instead of its private credential file: %v", calls[7].argv)
		}
	}

	if got, want := realArgv(calls[8].argv), []string{"rm", "-rf", "--", privateDir}; !equalArgv(got, want) {
		t.Fatalf("cleanup argv = %v, want %v", got, want)
	}
}

func TestCloneRepoClonesChecksOutAndPushesAFreshSandbox(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{
		{stdout: testBranch + "\n"}, // printenv SF_BRANCH
		{},                          // tar -xf (writeCredentials)
		notARepo,                    // git rev-parse (no existing checkout)
		{},                          // rm -rf (clear whatever is there)
		{},                          // git clone
		{},                          // git checkout -b
		{},                          // git config --local user.name
		{},                          // git config --local user.email
		{},                          // hardened git push to configured URL
	}}
	s, _ := newTestSandboxes(t, str, runningPod())

	if err := s.CloneRepo(context.Background(), testSandbox, testCloneURL, testCredential("ghs_secret")); err != nil {
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
	credentialEntry := entries[len(entries)-1]
	if credentialEntry.name != strings.TrimPrefix(credentialsPath, "/") {
		t.Fatalf("credential write entries = %+v, want final entry at %s", entries, credentialsPath)
	}
	if credentialEntry.mode != 0o600 {
		t.Fatalf("credential file mode = %o, want 0600", credentialEntry.mode)
	}
	if !strings.Contains(credentialEntry.body, "x-access-token:ghs_secret@github.com") {
		t.Fatalf("credential file body = %q, does not carry the minted token", credentialEntry.body)
	}

	if got := realArgv(calls[2].argv); len(got) < 2 || got[0] != "git" || got[len(got)-1] != "HEAD" {
		t.Fatalf("call 2 = %v, want the rev-parse probe", got)
	}
	if got := realArgv(calls[3].argv); len(got) != 4 || got[0] != "rm" || got[3] != work.RepoDir {
		t.Fatalf("call 3 = %v, want rm -rf -- %s", got, work.RepoDir)
	}

	clone := realArgv(calls[4].argv)
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

	checkout := realArgv(calls[5].argv)
	if checkout[len(checkout)-2] != "-b" || checkout[len(checkout)-1] != testBranch {
		t.Fatalf("checkout argv = %v, want checkout -b %s", checkout, testBranch)
	}

	configs := [][]string{
		{"git", "-C", work.RepoDir, "config", "--local", "user.name", testBotLogin},
		{"git", "-C", work.RepoDir, "config", "--local", "user.email", "309464436+" + testBotLogin + "@users.noreply.github.com"},
	}
	for i, want := range configs {
		if got := realArgv(calls[6+i].argv); !equalArgv(got, want) {
			t.Fatalf("config %d argv = %v, want %v", i, got, want)
		}
	}

	push := realArgv(calls[8].argv)
	if want := []string{
		"git", "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", credentialHelper,
		"-C", work.RepoDir, "push", "--set-upstream", "--", testCloneURL,
		testBranch + ":refs/heads/" + testBranch,
	}; !equalArgv(push, want) {
		t.Fatalf("push argv = %v, want %v", push, want)
	}

	// CloneRepo may retain its private credential inside the repository
	// container, but it must never copy or manipulate it through /work.
	for _, c := range calls {
		argv := realArgv(c.argv)
		if len(argv) >= 2 && argv[0] == "rm" && containsArg(argv, credentialsPath) {
			t.Fatalf("removed the repository-container credential through a command: %v", argv)
		}
	}
}

func TestCloneRepoLeavesAnExistingCheckoutOnTheRunsBranchAloneButPushesAnyway(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{
		{stdout: testBranch + "\n"}, // printenv SF_BRANCH
		{},                          // tar -xf (writeCredentials)
		{stdout: testBranch + "\n"}, // git rev-parse: already on this run's branch
		{},                          // git config --local user.name
		{},                          // git config --local user.email
		{},                          // hardened git push
	}}
	s, _ := newTestSandboxes(t, str, runningPod())

	if err := s.CloneRepo(context.Background(), testSandbox, testCloneURL, testCredential("t")); err != nil {
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
	// Non-secret author identity is reconfigured when a checkout is reused, so
	// a retry leaves the same commit environment as a fresh clone.
	for i, want := range [][]string{
		{"git", "-C", work.RepoDir, "config", "--local", "user.name", testBotLogin},
		{"git", "-C", work.RepoDir, "config", "--local", "user.email", "309464436+" + testBotLogin + "@users.noreply.github.com"},
	} {
		if got := realArgv(calls[3+i].argv); !equalArgv(got, want) {
			t.Fatalf("config %d argv = %v, want %v", i, got, want)
		}
	}
	push := realArgv(calls[5].argv)
	if push[len(push)-1] != testBranch+":refs/heads/"+testBranch {
		t.Fatalf("push argv = %v, want it to still push the branch", push)
	}
}

func TestCloneRepoRefusesAnExistingCheckoutOnTheWrongBranch(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{
		{stdout: testBranch + "\n"},         // printenv SF_BRANCH
		{},                                  // tar -xf (writeCredentials)
		{stdout: "somebody-elses-branch\n"}, // git rev-parse: a DIFFERENT checkout
	}}
	s, _ := newTestSandboxes(t, str, runningPod())

	err := s.CloneRepo(context.Background(), testSandbox, testCloneURL, testCredential("t"))
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
	if len(calls) != 3 {
		t.Fatalf("issued %d exec calls, want exactly 3 (no clone, no checkout, no config, no push): %+v", len(calls), calls)
	}
}

func TestCloneRepoSurfacesAGitFailureWithoutMarkingItPermanent(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{
		{stdout: testBranch + "\n"}, // printenv SF_BRANCH
		{},                          // tar -xf (writeCredentials)
		notARepo,                    // git rev-parse (no existing checkout)
		{},                          // rm -rf
		{err: utilexec.CodeExitError{Err: errors.New("fatal: unable to access"), Code: 128}}, // git clone fails
	}}
	s, _ := newTestSandboxes(t, str, runningPod())

	err := s.CloneRepo(context.Background(), testSandbox, testCloneURL, testCredential("t"))
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
		{stdout: "somebody-elses-branch\n"}, // git rev-parse: a DIFFERENT checkout — CloneRepo refuses
	}}
	s, _ := newTestSandboxes(t, str, runningPod())

	if err := s.CloneRepo(context.Background(), testSandbox, testCloneURL, testCredential("t")); err == nil {
		t.Fatal("expected the wrong-branch refusal")
	}

	for _, c := range str.observed() {
		argv := realArgv(c.argv)
		if len(argv) > 0 && argv[0] == "rm" {
			t.Fatalf("a failed CloneRepo removed something: %v — nothing here may clean up the credential file", argv)
		}
	}
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

// realArgv used to strip a sandbox-exec shim prefix from every exec call.
// #434 deleted that shim, so Exec
// now passes argv through untouched and this is the identity — kept, rather
// than inlined at every call site below, so this file's assertions still read
// as "the argv this line actually asked to run" without a rename pass.
func realArgv(argv []string) []string {
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
