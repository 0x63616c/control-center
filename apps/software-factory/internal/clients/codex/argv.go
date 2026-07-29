package codex

import (
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// The codex CLI's own spelling, verified against rust-v0.145.0
// (codex-rs/exec/src/cli.rs, codex-rs/utils/cli/src/shared_options.rs). They
// are constants so the argv below reads as a command rather than as string
// literals, and so a rename is one edit.
const (
	flagJSON              = "--json"
	flagBypassSandbox     = "--dangerously-bypass-approvals-and-sandbox"
	flagModel             = "--model"
	flagConfig            = "--config"
	flagCd                = "--cd"
	flagOutputSchema      = "--output-schema"
	flagOutputLastMessage = "--output-last-message"

	// configReasoningEffort is the config key `-c` sets to choose how hard the
	// model thinks. Verified against rust-v0.145.0: the TOML key and the Config
	// field are both model_reasoning_effort.
	configReasoningEffort = "model_reasoning_effort"
)

// stageArgv is the command one stage attempt runs, and the only place it is
// built.
//
// Three things about it are load-bearing:
//
// The prompt is not in it. It arrives on stdin and is written into the sandbox
// as a file, because it contains issue text chosen by whoever filed the ticket.
// Nothing here interpolates, quotes or escapes, because there is no shell at
// either end to need it — and the guarantee only holds end to end.
//
// The sandbox flag is explicit. Without it codex applies its own sandbox policy
// on top of ours, which defaults to read-only, so the implement stage would
// quietly fail to write anything. ADR-0011 makes the pod the isolation
// boundary; codex's in-process sandbox inside it is redundant, and the pod
// holds nothing valuable and reaches nothing valuable.
//
// The working directory is set explicitly, to work.RepoDir. It cannot be left
// to the image's WORKDIR, which is work.SandboxRoot: /work is an emptyDir, and
// a WORKDIR the container runtime has to create inside one is created as root
// mode 0755, so the sandbox uid cannot write its own checkout. The clone is
// therefore made by the process that clones it — which owns what it creates —
// and codex has to be pointed at the result.
//
// work.RepoDir is a subdirectory of the sandbox root rather than the root
// itself so that this attempt's prompt, schema and result stay OUTSIDE the git
// working tree. Inside it, the implement stage would be one `git add -A` away
// from committing a prompt into the branch it pushes.
//
// Getting this wrong does not look like a configuration error: codex exec in a
// directory that is not a git repository exits with "Not inside a trusted
// directory and --skip-git-repo-check was not specified" before it calls a
// model at all, so the stage reads as the model failing at its task.
func stageArgv(run work.StageRun) []string {
	paths := run.Key.Paths()
	return []string{
		"codex", "exec",
		flagJSON,
		flagBypassSandbox,
		flagCd, work.RepoDir,
		flagModel, run.Model.Name,
		flagConfig, fmt.Sprintf("%s=%s", configReasoningEffort, run.Model.Effort),
		flagOutputSchema, paths.Schema,
		flagOutputLastMessage, paths.Result,
	}
}
