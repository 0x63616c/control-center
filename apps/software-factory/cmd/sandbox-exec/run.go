package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
)

// run starts argv, records its PID, and exits with its status.
//
// The child is put in its own process group so --kill can address the whole
// tree. A stage is `codex exec`, which spawns compilers, package managers and
// test runners; signalling only the direct child would leave those running and
// the pod's CPU budget spent on work nothing is waiting for.
func run(pidfilePath string, argv []string, stderr io.Writer) int {
	// /work is an emptyDir and is EMPTY at mount, so any .exec directory baked
	// into the image is masked at runtime. Without this the pidfile would never
	// appear, --kill would become a silent no-op, and kill-on-cancel would be
	// defeated while still logging that a kill was attempted.
	if err := os.MkdirAll(filepath.Dir(pidfilePath), 0o755); err != nil {
		fmt.Fprintf(stderr, "sandbox-exec: creating the pidfile directory for %s: %v\n", pidfilePath, err)
		return exitInternal
	}

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	if err := cmd.Start(); err != nil {
		fmt.Fprintf(stderr, "sandbox-exec: starting %s: %v\n", argv[0], err)
		if errors.Is(err, exec.ErrNotFound) || errors.Is(err, syscall.ENOENT) {
			return exitNotFound
		}
		return exitCannotRun
	}

	if err := writePIDFile(pidfilePath, cmd.Process.Pid); err != nil {
		// Loud, not best-effort. A running child whose PID nothing recorded is
		// exactly the failure this shim exists to prevent: the caller would
		// cancel, issue a kill that finds no pidfile, and log a kill it never
		// performed while the stage kept burning quota.
		fmt.Fprintf(stderr, "sandbox-exec: recording the child PID in %s: %v; killing the child\n", pidfilePath, err)
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Wait()
		return exitInternal
	}

	waitErr := cmd.Wait()

	// Removed on every path, including a signalled child: a stale pidfile would
	// make a later kill address a PID the kernel has since reused.
	if err := os.Remove(pidfilePath); err != nil && !errors.Is(err, os.ErrNotExist) {
		fmt.Fprintf(stderr, "sandbox-exec: removing %s: %v\n", pidfilePath, err)
	}

	return exitStatus(waitErr, stderr)
}

// writePIDFile records pid at p, atomically.
//
// Temp-file-and-rename rather than a plain write, because --kill can read this
// file at any moment and a partially written number parses as a DIFFERENT,
// smaller PID — which would be signalled instead of the child.
func writePIDFile(p string, pid int) error {
	dir := filepath.Dir(p)
	f, err := os.CreateTemp(dir, filepath.Base(p)+".tmp*")
	if err != nil {
		return fmt.Errorf("creating a temporary pidfile in %s: %w", dir, err)
	}
	tmp := f.Name()

	if _, err := f.WriteString(strconv.Itoa(pid) + "\n"); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("writing %s: %w", tmp, err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("closing %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("renaming %s to %s: %w", tmp, p, err)
	}
	return nil
}

// exitStatus renders a child's termination as this process's exit status.
//
// The whole stage success/failure signal rests on the exit code that reaches
// the worker, and this shim sits in the middle of it. A signalled child becomes
// 128+signal, the shell convention, so a SIGKILLed stage is distinguishable
// from one that chose to exit 9.
func exitStatus(waitErr error, stderr io.Writer) int {
	if waitErr == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if !errors.As(waitErr, &exitErr) {
		fmt.Fprintf(stderr, "sandbox-exec: waiting for the child: %v\n", waitErr)
		return exitInternal
	}
	status, ok := exitErr.Sys().(syscall.WaitStatus)
	if !ok {
		return exitErr.ExitCode()
	}
	if status.Signaled() {
		return 128 + int(status.Signal())
	}
	return status.ExitStatus()
}
