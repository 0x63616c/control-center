// Package local implements codex.PodExecer and codex.FileTransfer for use
// INSIDE a sandbox pod's own process, backed by os/exec and the local
// filesystem rather than a remote pods/exec transport.
//
// It exists because #434 (step 3 of the software-factory migration) moves
// stage execution off the main worker and into the sandbox pod itself,
// running under a Temporal Session: a stage's `codex exec` is now a local
// subprocess of the very activity that runs it, not a remote command reached
// over the Kubernetes API. codex.Runner is already transport-agnostic — this
// is the second implementation of its two narrow interfaces, alongside
// internal/clients/k8s's remote one, and the two never mix: a Runner is
// constructed with one or the other, never both.
//
// A new package rather than a second role inside internal/clients/k8s: this
// code is not a Kubernetes client at all — it never imports k8s.io, holds no
// clientset, and knows nothing about pods — so putting it in k8s would leak
// that package's whole worldview into something that does not need it
// (SoftwareStyle tenet 4, "no leaky abstractions"). Both LocalExecer and
// LocalFileTransfer hold no state: unlike *k8s.Sandboxes, which knows which
// pod it is executing into, this package's only sandbox is the process it
// already runs in, so the work.SandboxID every interface method takes is
// accepted for interface compatibility and never inspected.
package local

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// Execer runs a command as a local subprocess, satisfying codex.PodExecer.
//
// It holds no state: unlike a remote exec, there is nothing to dial and
// nothing this session runs against but its own process. NewExecer exists
// anyway, both for symmetry with the FileTransfer constructor and because a
// zero-value Execer would be a usable-but-invalid pattern this codebase
// otherwise avoids.
type Execer struct{}

// NewExecer builds an Execer.
func NewExecer() Execer { return Execer{} }

// Exec runs argv as a local subprocess and returns its exit code.
//
// A non-zero code is evidence, not an error, the same distinction
// k8s.Sandboxes.Exec draws: the caller must report a failed command, while a
// non-nil error means the command could not be started or run at all. stdin
// may be nil for a command that reads none.
//
// Cancelling ctx kills the process directly — exec.CommandContext holds the
// real child PID in this same process, so no out-of-band cancellation is
// needed. This is the Session-bound execution model #434 introduced.
func (Execer) Exec(ctx context.Context, _ work.SandboxID, argv []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	if len(argv) == 0 {
		return 0, fmt.Errorf("running a local command: argv is empty: %w", work.ErrPermanent)
	}

	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Stdin = stdin
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	err := cmd.Run()
	if err == nil {
		return 0, nil
	}

	// CommandContext kills the process on cancellation and returns the
	// context's own error (wrapped) rather than an *exec.ExitError — checked
	// before ExitError, the same ordering k8s.Sandboxes.exec uses, so a
	// cancelled run is never misread as a command that merely failed.
	if ctxErr := ctx.Err(); ctxErr != nil {
		return 0, fmt.Errorf("running %s: %w", argv[0], ctxErr)
	}

	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode(), nil
	}
	return 0, fmt.Errorf("running %s: %w", argv[0], err)
}

// FileTransfer reads and writes files on the local filesystem, satisfying
// codex.FileTransfer.
type FileTransfer struct{}

// NewFileTransfer builds a FileTransfer.
func NewFileTransfer() FileTransfer { return FileTransfer{} }

// dirMode is the mode every parent directory Write creates is given — never
// the file's own mode, for the reason k8s/transfer.go's dirMode gives: a
// credential file at 0600 under a directory that inherited its mode would be
// unreachable, not merely misreadable.
const dirMode fs.FileMode = 0o755

// Write puts content at path with the requested mode, creating any parent
// directories it needs.
//
// path must be absolute. codex.FileTransfer's callers already only ever pass
// paths under work.SandboxRoot (StagePaths, CodexAuthFile, GhHostsFile), so
// this is a cheap check against a caller bug rather than the sandboxed
// confinement k8s/transfer.go's sandboxPath enforces against a REMOTE
// caller — there is no remote caller here, this process IS the sandbox.
func (FileTransfer) Write(_ context.Context, _ work.SandboxID, path string, content []byte, mode fs.FileMode) error {
	if !filepath.IsAbs(path) {
		return fmt.Errorf("writing %q: the path must be absolute: %w", path, work.ErrPermanent)
	}
	if mode&^fs.ModePerm != 0 {
		return fmt.Errorf("writing %q: mode %v carries bits that mean nothing for a file: %w", path, mode, work.ErrPermanent)
	}

	if err := os.MkdirAll(filepath.Dir(path), dirMode); err != nil {
		return fmt.Errorf("creating the parent directory for %q: %w", path, err)
	}
	if err := os.WriteFile(path, content, mode); err != nil {
		return fmt.Errorf("writing %q: %w", path, err)
	}
	return nil
}

// Read returns the bytes of the file at path.
//
// It returns an error satisfying errors.Is(err, work.ErrFileNotFound) when,
// and only when, the file is absent — the same contract k8s.Sandboxes.Read
// promises, and the one codex.Decide's idempotency check depends on: a
// transient failure misreported as absence pays for a finished stage twice.
func (FileTransfer) Read(_ context.Context, _ work.SandboxID, path string) ([]byte, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("reading %q: %w", path, work.ErrFileNotFound)
		}
		return nil, fmt.Errorf("reading %q: %w", path, err)
	}
	return content, nil
}
