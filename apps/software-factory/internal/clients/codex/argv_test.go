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
		Key:     work.StageKey{Ticket: 312, RunID: "0198c2f1", Stage: work.StagePlan},
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
		"--model", "gpt-5.6-terra",
		"--config", "model_reasoning_effort=medium",
		"--output-schema", "/work/0198c2f1/plan/schema.json",
		"--output-last-message", "/work/0198c2f1/plan/result.json",
	}

	if got := stageArgv(testRun()); !slices.Equal(got, want) {
		t.Errorf("stageArgv() =\n  %q\nwant\n  %q", got, want)
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

	for _, arg := range stageArgv(run) {
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
	for _, arg := range stageArgv(testRun()) {
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
	argv := stageArgv(run)

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
	first := stageArgv(testRun())

	other := testRun()
	other.Key.RunID = "run-b"
	second := stageArgv(other)

	if slices.Equal(first, second) {
		t.Error("two runs of the same stage produce identical argv; the second would read the first's result file")
	}
}
