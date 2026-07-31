package work

import (
	"strings"
	"testing"
)

func TestFactoryTicketWorkflowIDsUseADisjointNamespace(t *testing.T) {
	t.Parallel()

	for _, id := range []int64{0, 1, 7, 99} {
		// The retired GitHub-backed pipeline (#559) claimed `work-ticket-<n>`.
		// Temporal lets a closed run's ID be reused, so a small Ticket id under
		// that prefix would share a history lineage with the issue of the same
		// number — which is why this prefix must stay disjoint from it even now
		// that nothing mints the old one.
		if strings.HasPrefix(FactoryTicketWorkflowID(id), "work-ticket-") {
			t.Fatalf("Ticket id %d claims the retired GitHub-issue workflow ID namespace", id)
		}
		if !strings.HasPrefix(FactoryTicketWorkflowID(id), "factory-ticket-") {
			t.Fatalf("FactoryTicketWorkflowID(%d) = %q", id, FactoryTicketWorkflowID(id))
		}
	}
}

func TestParseFactoryTicketBranchNameInvertsTheConstructor(t *testing.T) {
	t.Parallel()

	for _, id := range []int64{1, 7, 99, 123456} {
		for _, runID := range []string{"019a3f2c-7b1e-4f9a-9c2d-3e5f6a7b8c9d", "run"} {
			branch := FactoryTicketBranchName(id, runID)
			got, ok := ParseFactoryTicketBranchName(branch)
			if !ok {
				t.Fatalf("ParseFactoryTicketBranchName(%q) ok = false, want true", branch)
			}
			if got != id {
				t.Errorf("ParseFactoryTicketBranchName(%q) = %d, want %d", branch, got, id)
			}
		}
	}
}

func TestParseFactoryTicketBranchNameRejectsAnythingElse(t *testing.T) {
	t.Parallel()

	// branch is attacker-controllable: it arrives off a pull_request webhook
	// payload from anyone who can open a PR against this repo. Every case here
	// must fail closed rather than resolve to some TicketID.
	cases := []string{
		"",
		"main",
		"software-factory/ticket-42/run", // legacy GitHub-issue branch, disjoint prefix
		"software-factory/factory-ticket-/run",
		"software-factory/factory-ticket-abc/run",
		"software-factory/factory-ticket-42",        // missing run segment
		"software-factory/factory-ticket-42/run/rm", // extra segment
		"software-factory/factory-ticket-42/",       // empty run segment
		"software-factory/factory-ticket-0/run",     // not a positive TicketID
		"software-factory/factory-ticket--1/run",    // signed
		"software-factory/factory-ticket-01/run",    // leading zero
		"SOFTWARE-FACTORY/factory-ticket-42/run",    // case must match exactly
		"other-prefix/factory-ticket-42/run",
	}
	for _, branch := range cases {
		if id, ok := ParseFactoryTicketBranchName(branch); ok {
			t.Errorf("ParseFactoryTicketBranchName(%q) = (%d, true), want ok = false", branch, id)
		}
	}
}

func TestFactoryDispatcherStartsWithOneTicketAtATime(t *testing.T) {
	t.Parallel()

	if got := DefaultFactoryConfig().MaxInFlight; got != 1 {
		t.Fatalf("DefaultFactoryConfig().MaxInFlight = %d, want 1", got)
	}
}

func TestRepoDirIsInsideTheSandboxRootWithoutBeingIt(t *testing.T) {
	// Inside, because transfer.go confines every write to the sandbox root.
	// Not equal to it, because the run's own scaffolding lives at the root and
	// a checkout over the top of that puts prompts inside the git working tree.
	if !strings.HasPrefix(RepoDir, SandboxRoot+"/") {
		t.Errorf("RepoDir = %q, want a path under %q", RepoDir, SandboxRoot)
	}
	if RepoDir == SandboxRoot {
		t.Errorf("RepoDir must not be the sandbox root itself: %q", RepoDir)
	}
}

func TestStageScaffoldingIsNotInsideTheCheckout(t *testing.T) {
	// The reason RepoDir is a sibling of the scaffolding rather than its parent:
	// anything under the checkout is untracked content in the working tree that
	// `implement` could commit into the branch it pushes.
	paths := StageKey{Ticket: 1, RunID: "run", Stage: StagePlan, Turn: 1}.Paths()
	if strings.HasPrefix(paths.Dir, RepoDir+"/") {
		t.Errorf("stage dir %q is inside the checkout %q", paths.Dir, RepoDir)
	}
}
