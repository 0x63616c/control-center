package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// pollInterval is how often the two waits below re-check. Short enough that a
// grace period is spent waiting rather than rounding, cheap enough that the
// polling itself is invisible next to a stage.
const pollInterval = 50 * time.Millisecond

// kill stops the process group recorded in pidfilePath: SIGTERM, then SIGKILL
// after grace.
//
// Escalation rather than an immediate SIGKILL because the child is `codex
// exec`, which flushes its event stream and its result file on the way out —
// and the result file is what makes a stage idempotent under retry.
func kill(pidfilePath string, grace time.Duration, stderr io.Writer) int {
	pid, err := awaitPID(pidfilePath)
	if err != nil {
		warn(stderr, "%v", err)
		return exitInternal
	}

	// Negative PID: the whole process group, which is why run mode created one.
	if err := syscall.Kill(-pid, syscall.SIGTERM); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return 0 // Already gone. The caller asked for stopped, and it is.
		}
		warn(stderr, "sending SIGTERM to process group %d: %v", pid, err)
		return exitInternal
	}

	if awaitGone(pidfilePath, pid, grace) {
		return 0
	}

	if err := syscall.Kill(-pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		warn(stderr, "sending SIGKILL to process group %d: %v", pid, err)
		return exitInternal
	}
	return 0
}

// awaitPID reads the PID from pidfilePath, waiting for the file to appear.
//
// The wait exists because run mode writes the pidfile just after fork, and a
// cancellation arriving inside that window would otherwise find nothing and
// report a kill it never performed.
func awaitPID(pidfilePath string) (int, error) {
	timeout := time.NewTimer(pidfileWait)
	defer timeout.Stop()
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		pid, err := readPIDFile(pidfilePath)
		if err == nil {
			return pid, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return 0, err
		}
		select {
		case <-timeout.C:
			return 0, fmt.Errorf("no pidfile appeared at %s within %s", pidfilePath, pidfileWait)
		case <-ticker.C:
		}
	}
}

// readPIDFile parses the PID one pidfile records.
//
// An empty or unparseable file is an error rather than a zero, because 0 as a
// negated signal target means "every process this uid can reach" — the sandbox
// uid's whole session, including the shim asking for the kill.
func readPIDFile(pidfilePath string) (int, error) {
	raw, err := os.ReadFile(pidfilePath)
	if err != nil {
		return 0, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		return 0, fmt.Errorf("reading the PID in %s: %w", pidfilePath, err)
	}
	if pid <= 0 {
		return 0, fmt.Errorf("reading the PID in %s: %d is not a process id", pidfilePath, pid)
	}
	return pid, nil
}

// awaitGone reports whether the group ended within grace.
//
// Two independent signals, because neither alone is sufficient. The pidfile
// disappearing means run mode reaped the child and cleaned up — the definitive
// answer, and the only one available while the group leader is still a zombie
// that signal 0 finds alive. ESRCH covers the case where run mode died without
// cleaning up.
func awaitGone(pidfilePath string, pid int, grace time.Duration) bool {
	deadline := time.NewTimer(grace)
	defer deadline.Stop()
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		if _, err := os.Stat(pidfilePath); errors.Is(err, os.ErrNotExist) {
			return true
		}
		if err := syscall.Kill(-pid, syscall.Signal(0)); errors.Is(err, syscall.ESRCH) {
			return true
		}
		select {
		case <-deadline.C:
			return false
		case <-ticker.C:
		}
	}
}
