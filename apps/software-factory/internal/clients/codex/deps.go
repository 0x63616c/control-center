package codex

import (
	"context"
	"io"
	"io/fs"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// PodExecer runs a command inside an already-running sandbox.
//
// Argv is handed to the container's exec directly. There is no shell, ever —
// not here and not in the sandbox image's entrypoint. Issue titles and bodies
// are attacker-controlled and reach this service as prompts; the guarantee that
// they cannot become a command only holds end to end, so a shell reintroduced
// at either end defeats it entirely.
//
// The returned int is the command's exit code, which is evidence rather than an
// error: a stage that exits non-zero has failed in a way the caller must
// report, while a non-nil error means the exec itself could not be carried out
// and says nothing about the command. Collapsing the two would make a failed
// stage indistinguishable from an unreachable cluster.
//
// Implementations must honour context cancellation by killing the remote
// process, not merely by returning: an activity timeout that leaves a codex
// process running in the sandbox burns quota nobody is waiting for.
type PodExecer interface {
	Exec(ctx context.Context, sandbox work.SandboxID, argv []string, stdout, stderr io.Writer) (int, error)
}

// FileTransfer moves files between the worker and a sandbox. It is how a
// credential and a rendered prompt get in, and how a result and a transcript
// get out.
//
// Read must return an error satisfying errors.Is(err, work.ErrFileNotFound)
// when the path is absent, and only then. Absence is not an edge case here: it
// is the signal the resume decision is built on, so an implementation that
// reports "missing" for a transient failure would cause a finished stage to be
// paid for twice.
type FileTransfer interface {
	Write(ctx context.Context, sandbox work.SandboxID, path string, content []byte, mode fs.FileMode) error
	Read(ctx context.Context, sandbox work.SandboxID, path string) ([]byte, error)
}
