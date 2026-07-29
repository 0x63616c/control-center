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
		notARepo,                    // git rev-parse (no existing checkout)
		{},                          // rm -rf (clear whatever is there)
		{},                          // git clone
		{},                          // git checkout -b
		{},                          // git push -u origin
		{},                          // rm -f (remove credentials)
	}}
	s, _ := newTestSandboxes(t, str, runningPod())

	if err := s.CloneRepo(context.Background(), testSandbox, testCloneURL, work.NewCredential("ghs_secret")); err != nil {
		t.Fatalf("CloneRepo: %v", err)
	}

	calls := str.observed()
	if len(calls) != 8 {
		t.Fatalf("issued %d exec calls, want 8: %+v", len(calls), calls)
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

	push := realArgv(calls[6].argv)
	if push[len(push)-2] != "origin" || push[len(push)-1] != testBranch {
		t.Fatalf("push argv = %v, want push -u origin %s", push, testBranch)
	}
	if !containsArg(push, credentialHelper) {
		t.Fatalf("push argv = %v, did not configure the credential helper", push)
	}

	if got := realArgv(calls[7].argv); len(got) != 4 || got[0] != "rm" || got[1] != "-f" {
		t.Fatalf("call 7 = %v, want the credential file removed", got)
	}
}

func TestCloneRepoLeavesAnExistingCheckoutOnTheRunsBranchAloneButPushesAnyway(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{
		{stdout: testBranch + "\n"}, // printenv SF_BRANCH
		{},                          // tar -xf (writeCredentials)
		{stdout: testBranch + "\n"}, // git rev-parse: already on this run's branch
		{},                          // git push -u origin
		{},                          // rm -f (remove credentials)
	}}
	s, _ := newTestSandboxes(t, str, runningPod())

	if err := s.CloneRepo(context.Background(), testSandbox, testCloneURL, work.NewCredential("t")); err != nil {
		t.Fatalf("CloneRepo: %v", err)
	}

	calls := str.observed()
	if len(calls) != 5 {
		t.Fatalf("issued %d exec calls, want 5 — no clone, no checkout: %+v", len(calls), calls)
	}
	for _, c := range calls {
		argv := realArgv(c.argv)
		if len(argv) > 0 && argv[0] == "git" && containsArg(argv, "clone") {
			t.Fatalf("re-cloned an existing checkout: %v", argv)
		}
	}
	push := realArgv(calls[3].argv)
	if push[len(push)-1] != testBranch {
		t.Fatalf("push argv = %v, want it to still push the branch", push)
	}
}

func TestCloneRepoRefusesAnExistingCheckoutOnTheWrongBranch(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{
		{stdout: testBranch + "\n"},         // printenv SF_BRANCH
		{},                                  // tar -xf (writeCredentials)
		{stdout: "somebody-elses-branch\n"}, // git rev-parse: a DIFFERENT checkout
		{},                                  // rm -f (removeCredentials still runs, deferred)
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
		t.Fatalf("issued %d exec calls, want exactly 4 (no clone, no checkout, no push): %+v", len(calls), calls)
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
		{}, // rm -f (removeCredentials, deferred)
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
