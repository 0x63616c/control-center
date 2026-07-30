package codex

import (
	"fmt"
	"path"

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

	// resumeSubcommand continues a previous codex conversation by thread id,
	// for implement's turn-to-turn resume (#435's pipeline rewrite — "Codex
	// sessions"). Verified against the installed codex-cli 0.145.0's own
	// `codex exec resume --help`: the documented shape is
	// `codex exec resume <SESSION_ID> [PROMPT]`, confirmed rather than assumed.
	resumeSubcommand = "resume"
)

// sessionIDFile is where implement's own resume identity is written, a
// sibling of every turn's own numbered StagePaths().Dir rather than inside
// one of them — the file argv reads from before turn N's own directory has
// been created and writes to after turn N-1's has already been used.
//
// Only implement ever reads or writes this path. review is deliberately never
// resumed (a fresh, unbiased thread every turn is its whole value), and
// nothing in this package ever passes StageReview to sessionIDFile's callers
// for that reason — see Runner.run.
func sessionIDFile(key work.StageKey) string {
	return path.Join(work.SandboxRoot, key.RunID, string(key.Stage), "session.id")
}

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
//
// resumeThreadID continues a previous codex conversation rather than starting
// fresh, and is empty on any turn that has none to continue — implement's
// first turn of a run, and every review turn (never resumed at all; see
// sessionIDFile). Runner.run is the only caller and the only place that
// decides what to pass here — this function does no I/O of its own and takes
// the caller's word for it.
//
// The subcommand goes LAST, after every exec-level flag, not first. codex's
// own usage is `codex exec [OPTIONS] <COMMAND> [ARGS]` — `resume` is a
// subcommand of `exec`, not a sibling flag, so anything placed after it is
// parsed as *resume's* own options rather than exec's. Verified directly:
// `codex exec --help` accepts `--cd`/`-C`; `codex exec resume --help` does
// not (it only takes `--all`/`--last` beyond the options the two share). A
// build that appended `resume <id>` right after `codex exec` and put `--cd`
// after that would therefore fail on every resumed turn — silently only on
// resumed turns, since turn one (never resumed) would look healthy. That
// exact ordering bug shipped here once; it is why this note exists.
func stageArgv(run work.StageRun, resumeThreadID string) []string {
	paths := run.Key.Paths()
	args := []string{
		"codex", "exec",
		flagJSON,
		flagBypassSandbox,
		flagCd, work.RepoDir,
		flagModel, run.Model.Name,
		flagConfig, fmt.Sprintf("%s=%s", configReasoningEffort, run.Model.Effort),
		flagOutputSchema, paths.Schema,
		flagOutputLastMessage, paths.Result,
	}
	if resumeThreadID != "" {
		args = append(args, resumeSubcommand, resumeThreadID)
	}
	return args
}
