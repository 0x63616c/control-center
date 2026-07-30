package codex

import (
	"slices"
	"strings"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// The flags below are codex's, verified against rust-v0.145.0
// (codex-rs/exec/src/cli.rs and codex-rs/utils/cli/src/shared_options.rs).
// This argv is asserted element for element rather than searched, because it is
// the command that spends money: a flag that silently stopped being passed
// would change what the model does, not whether it runs.

func testRun() work.StageRun {
	return work.StageRun{
		Key:     work.StageKey{Ticket: 312, RunID: "0198c2f1", Stage: work.StagePlan, Turn: 1},
		Sandbox: "sandbox-312",
		Model:   work.Model{Name: "gpt-5.6-terra", Effort: "medium"},
		Prompt:  "plan this ticket",
		Schema:  []byte(`{"type":"object"}`),
	}
}

func TestStageArgvIsTheWholeCommand(t *testing.T) {
	t.Parallel()

	want := []string{
		"codex", "exec",
		"--json",
		"--dangerously-bypass-approvals-and-sandbox",
		"--cd", "/work/repo",
		"--model", "gpt-5.6-terra",
		"--config", "model_reasoning_effort=medium",
		"--output-schema", "/work/0198c2f1/plan/1/schema.json",
		"--output-last-message", "/work/0198c2f1/plan/1/result.json",
	}

	if got := stageArgv(testRun(), ""); !slices.Equal(got, want) {
		t.Errorf("stageArgv() =\n  %q\nwant\n  %q", got, want)
	}
}

func TestStageArgvResumesWithATheadIDWhenGiven(t *testing.T) {
	t.Parallel()

	got := stageArgv(testRun(), "thread-abc")
	want := []string{
		"codex", "exec", resumeSubcommand, "thread-abc",
		"--json",
		"--dangerously-bypass-approvals-and-sandbox",
		"--cd", "/work/repo",
		"--model", "gpt-5.6-terra",
		"--config", "model_reasoning_effort=medium",
		"--output-schema", "/work/0198c2f1/plan/1/schema.json",
		"--output-last-message", "/work/0198c2f1/plan/1/result.json",
	}
	if !slices.Equal(got, want) {
		t.Errorf("stageArgv() with a resume id =\n  %q\nwant\n  %q", got, want)
	}
}

func TestStageArgvDoesNotResumeWithAnEmptyThreadID(t *testing.T) {
	t.Parallel()

	if got := stageArgv(testRun(), ""); slices.Contains(got, resumeSubcommand) {
		t.Errorf("stageArgv() with no thread id still resumes: %q", got)
	}
}

func TestTheStagePromptIsNeverAnArgument(t *testing.T) {
	t.Parallel()

	// The whole argv-only guarantee lands here. A ticket's title and body are
	// chosen by whoever filed the issue and are rendered into this prompt; the
	// prompt travels on stdin and as a file, so no part of it is ever a command
	// argument. k8s exec errors also summarise argv, so a prompt in argv would
	// additionally copy attacker-controlled text into the logs.
	run := testRun()
	run.Prompt = "--dangerously-bypass-approvals-and-sandbox ; rm -rf / `whoami`"

	for _, arg := range stageArgv(run, "") {
		if strings.Contains(arg, "rm -rf") || strings.Contains(arg, "whoami") {
			t.Fatalf("the prompt reached argv as %q", arg)
		}
	}
}

func TestEveryArgumentIsItsOwnElement(t *testing.T) {
	t.Parallel()

	// There is no shell anywhere in this path, so nothing splits an argument on
	// spaces. A flag and its value packed into one element ("--model gpt-...")
	// would arrive at execve as a single unrecognised argument.
	for _, arg := range stageArgv(testRun(), "") {
		if strings.ContainsAny(arg, " \t") {
			t.Errorf("argv element %q holds whitespace; nothing will split it", arg)
		}
	}
}

func TestTheModelAndEffortComeFromTheStagesOwnConfig(t *testing.T) {
	t.Parallel()

	// Per-stage overrides exist so the adversarial reviewer can be given
	// different blind spots from the planner. If either value were pinned here,
	// the override in work.Config would be configuration that does nothing.
	run := testRun()
	run.Model = work.Model{Name: "other-model", Effort: "xhigh"}
	argv := stageArgv(run, "")

	if !slices.Contains(argv, "other-model") {
		t.Errorf("argv %q does not name the stage's model", argv)
	}
	if !slices.Contains(argv, "model_reasoning_effort=xhigh") {
		t.Errorf("argv %q does not carry the stage's reasoning effort", argv)
	}
}

func TestTheResultAndSchemaPathsAreTheStagesOwn(t *testing.T) {
	t.Parallel()

	// These two paths are what makes a stage idempotent under activity retry:
	// the result file's existence is the completion record, and both are
	// derived from the stage key alone. A second run of the same ticket must
	// not read the previous run's answer.
	first := stageArgv(testRun(), "")

	other := testRun()
	other.Key.RunID = "run-b"
	second := stageArgv(other, "")

	if slices.Equal(first, second) {
		t.Error("two runs of the same stage produce identical argv; the second would read the first's result file")
	}
}

func TestAStageRunsInTheCheckoutAndNotTheSandboxRoot(t *testing.T) {
	t.Parallel()

	// The image's WORKDIR is work.SandboxRoot, and it cannot be the checkout:
	// a WORKDIR the container runtime has to create inside the /work emptyDir
	// is created as root mode 0755, so the sandbox uid cannot write its own
	// clone. The checkout is therefore made by the process that clones it, at
	// work.RepoDir, and codex has to be pointed at it explicitly.
	//
	// Getting this wrong does not present as a configuration error. codex exec
	// outside a git repository dies with "Not inside a trusted directory"
	// BEFORE it calls a model, so the stage reads as the model failing at its
	// task rather than as the runner starting it in the wrong place.
	argv := stageArgv(testRun(), "")

	i := slices.Index(argv, flagCd)
	if i < 0 {
		t.Fatalf("argv does not pass %s, so codex runs in the image's WORKDIR (%s) instead of the checkout (%s):\n%q",
			flagCd, work.SandboxRoot, work.RepoDir, argv)
	}
	if i == len(argv)-1 {
		t.Fatalf("%s is the last argument and has no value:\n%q", flagCd, argv)
	}
	if got := argv[i+1]; got != work.RepoDir {
		t.Errorf("%s = %q, want the checkout %q — codex operates outside the repository anywhere else",
			flagCd, got, work.RepoDir)
	}
}

func TestTheStageScaffoldingStaysOutsideTheCheckout(t *testing.T) {
	t.Parallel()

	// The other half of why the checkout is a subdirectory rather than /work
	// itself: codex runs with the repository as its working directory, so
	// anything the run writes inside it is one `git add -A` away from being
	// committed to the branch the implement stage pushes.
	argv := stageArgv(testRun(), "")
	for _, arg := range argv {
		if arg == work.RepoDir {
			continue
		}
		if strings.HasPrefix(arg, work.RepoDir+"/") {
			t.Errorf("argv puts %q inside the checkout; the run's own files would be committable by the stage that writes the branch:\n%q", arg, argv)
		}
	}
}
