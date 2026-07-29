package main

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// tool resolves a POSIX utility the tests drive real processes with.
//
// The shim's whole subject is processes, so these tests fork them rather than
// faking them — there is nothing left to assert once the fork is a double. They
// stay hermetic in the sense that matters: no network, no cluster, no shared
// filesystem state.
func tool(t *testing.T, name string) string {
	t.Helper()
	p, err := exec.LookPath(name)
	if err != nil {
		t.Skipf("this test needs %s on PATH: %v", name, err)
	}
	return p
}

func TestRunCreatesThePIDFileParentDirectory(t *testing.T) {
	// THE requirement this shim is most likely to be built without: /work is an
	// emptyDir and is empty at mount, so a .exec directory baked into the image
	// is masked. Without the mkdir the pidfile never appears, --kill becomes a
	// no-op, and kill-on-cancel is silently defeated.
	dir := t.TempDir()
	pidfile := filepath.Join(dir, ".exec", "nested", "abc123.pid")

	var stderr strings.Builder
	code := run(pidfile, []string{tool(t, "true")}, &stderr)

	if code != 0 {
		t.Fatalf("run exited %d, want 0; stderr: %s", code, stderr.String())
	}
	if _, err := os.Stat(filepath.Dir(pidfile)); err != nil {
		t.Fatalf("the pidfile's parent directory was not created: %v", err)
	}
}

func TestRunRecordsTheChildPIDWhileItIsAlive(t *testing.T) {
	dir := t.TempDir()
	pidfile := filepath.Join(dir, ".exec", "live.pid")

	done := make(chan int, 1)
	go func() { done <- run(pidfile, []string{tool(t, "sleep"), "30"}, io.Discard) }()

	pid := awaitPIDForTest(t, pidfile)
	if err := syscall.Kill(pid, syscall.Signal(0)); err != nil {
		t.Fatalf("the recorded PID %d is not a live process: %v", pid, err)
	}

	_ = syscall.Kill(-pid, syscall.SIGKILL)
	<-done
}

func TestRunForwardsTheChildExitCode(t *testing.T) {
	for _, tc := range []struct {
		name string
		bin  string
		want int
	}{
		{name: "success", bin: "true", want: 0},
		{name: "failure", bin: "false", want: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pidfile := filepath.Join(t.TempDir(), ".exec", "e.pid")
			if got := run(pidfile, []string{tool(t, tc.bin)}, io.Discard); got != tc.want {
				t.Fatalf("run exited %d, want %d", got, tc.want)
			}
		})
	}
}

func TestRunRemovesThePIDFileWhenTheChildEnds(t *testing.T) {
	// A stale pidfile would make a later kill signal a PID the kernel reused.
	pidfile := filepath.Join(t.TempDir(), ".exec", "gone.pid")

	if code := run(pidfile, []string{tool(t, "true")}, io.Discard); code != 0 {
		t.Fatalf("run exited %d, want 0", code)
	}
	if _, err := os.Stat(pidfile); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the pidfile outlived the child: stat err = %v", err)
	}
}

func TestRunReportsAMissingCommandRatherThanSucceeding(t *testing.T) {
	pidfile := filepath.Join(t.TempDir(), ".exec", "missing.pid")

	var stderr strings.Builder
	code := run(pidfile, []string{filepath.Join(t.TempDir(), "no-such-binary")}, &stderr)

	if code != exitNotFound {
		t.Fatalf("run exited %d, want %d", code, exitNotFound)
	}
	if stderr.Len() == 0 {
		t.Fatal("a shim failure must say so on stderr; the exit code alone is ambiguous with a child's")
	}
}

func TestRunFailsLoudlyWhenThePIDFileCannotBeWritten(t *testing.T) {
	// The silent-defeat case: a running child nothing recorded. Better to fail
	// the stage than to run one that cancellation cannot reach.
	if os.Geteuid() == 0 {
		t.Skip("root ignores the directory permissions this test relies on")
	}
	dir := t.TempDir()
	locked := filepath.Join(dir, "locked")
	if err := os.Mkdir(locked, 0o500); err != nil {
		t.Fatalf("preparing the unwritable directory: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o700) })

	var stderr strings.Builder
	code := run(filepath.Join(locked, "x.pid"), []string{tool(t, "sleep"), "30"}, &stderr)

	if code == 0 {
		t.Fatal("run exited 0 having never recorded a PID; the stage would be uncancellable")
	}
	if stderr.Len() == 0 {
		t.Fatal("stderr must explain why the run was refused")
	}
}

func TestKillStopsTheChild(t *testing.T) {
	pidfile := filepath.Join(t.TempDir(), ".exec", "kill.pid")

	done := make(chan int, 1)
	go func() { done <- run(pidfile, []string{tool(t, "sleep"), "60"}, io.Discard) }()
	awaitPIDForTest(t, pidfile)

	var stderr strings.Builder
	if code := kill(pidfile, 2*time.Second, &stderr); code != 0 {
		t.Fatalf("kill exited %d, want 0; stderr: %s", code, stderr.String())
	}

	select {
	case code := <-done:
		if code != 128+int(syscall.SIGTERM) {
			t.Fatalf("run exited %d, want %d (128+SIGTERM)", code, 128+int(syscall.SIGTERM))
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the child outlived its kill")
	}
}

func TestKillStopsGrandchildren(t *testing.T) {
	// The reason run mode creates a process group at all: a stage is `codex
	// exec`, whose real cost is the compilers and test runners it spawns.
	sh := tool(t, "sh")
	dir := t.TempDir()
	pidfile := filepath.Join(dir, ".exec", "tree.pid")
	marker := filepath.Join(dir, "grandchild.pid")

	done := make(chan int, 1)
	go func() {
		done <- run(pidfile, []string{sh, "-c", "sleep 60 & echo $! > " + marker + "; wait"}, io.Discard)
	}()
	awaitPIDForTest(t, pidfile)
	grandchild := awaitPIDForTest(t, marker)

	if code := kill(pidfile, 2*time.Second, io.Discard); code != 0 {
		t.Fatalf("kill exited %d, want 0", code)
	}
	<-done

	if !eventuallyGone(grandchild) {
		t.Fatalf("grandchild %d survived the kill; only the direct child was signalled", grandchild)
	}
}

func TestKillWaitsForAPIDFileThatHasNotAppearedYet(t *testing.T) {
	// Cancellation can arrive between fork and the pidfile write. Without the
	// wait, the kill would find nothing and report success having done nothing.
	pidfile := filepath.Join(t.TempDir(), ".exec", "late.pid")

	started := make(chan struct{})
	done := make(chan int, 1)
	go func() {
		close(started)
		done <- run(pidfile, []string{tool(t, "sleep"), "60"}, io.Discard)
	}()
	<-started

	if code := kill(pidfile, 2*time.Second, io.Discard); code != 0 {
		t.Fatalf("kill exited %d, want 0", code)
	}
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the child outlived a kill issued before its pidfile existed")
	}
}

func TestKillReportsAPIDFileThatNeverAppears(t *testing.T) {
	var stderr strings.Builder
	code := kill(filepath.Join(t.TempDir(), "absent.pid"), time.Second, &stderr)

	if code == 0 {
		t.Fatal("kill exited 0 with no pidfile; the caller would log a kill that never happened")
	}
	if stderr.Len() == 0 {
		t.Fatal("stderr must say the pidfile never appeared")
	}
}

func TestReadPIDFileRejectsUnusableContent(t *testing.T) {
	// A negated 0 signals every process the uid can reach, which in the sandbox
	// is the session issuing the kill.
	for _, tc := range []struct{ name, content string }{
		{name: "empty", content: ""},
		{name: "zero", content: "0\n"},
		{name: "negative", content: "-1\n"},
		{name: "not a number", content: "codex\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := filepath.Join(t.TempDir(), "p.pid")
			if err := os.WriteFile(p, []byte(tc.content), 0o600); err != nil {
				t.Fatalf("writing the fixture: %v", err)
			}
			if _, err := readPIDFile(p); err == nil {
				t.Fatalf("readPIDFile accepted %q", tc.content)
			}
		})
	}
}

func TestDispatchRejectsInvocationsItCannotServe(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
	}{
		{name: "no mode", args: nil},
		{name: "both modes", args: []string{"--pidfile", "/tmp/a.pid", "--kill", "/tmp/a.pid"}},
		{name: "run without a command", args: []string{"--pidfile", "/tmp/a.pid"}},
		{name: "kill with a command", args: []string{"--kill", "/tmp/a.pid", "--", "echo"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if code := dispatch(tc.args, io.Discard); code != exitUsage {
				t.Fatalf("dispatch exited %d, want %d", code, exitUsage)
			}
		})
	}
}

func TestDispatchRunsTheCommandAfterTheSeparator(t *testing.T) {
	// Guards the argv contract with internal/clients/k8s: everything after --
	// is the child's, flags before it are the shim's.
	pidfile := filepath.Join(t.TempDir(), ".exec", "d.pid")
	code := dispatch([]string{"--pidfile", pidfile, "--", tool(t, "false")}, io.Discard)
	if code != 1 {
		t.Fatalf("dispatch exited %d, want the child's 1", code)
	}
}

// awaitPIDForTest blocks until a pidfile holds a usable PID.
func awaitPIDForTest(t *testing.T, pidfile string) int {
	t.Helper()
	deadline := time.After(10 * time.Second)
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		raw, err := os.ReadFile(pidfile)
		if err == nil {
			if pid, convErr := strconv.Atoi(strings.TrimSpace(string(raw))); convErr == nil && pid > 0 {
				return pid
			}
		}
		select {
		case <-deadline:
			t.Fatalf("no PID appeared in %s", pidfile)
		case <-tick.C:
		}
	}
}

// eventuallyGone reports whether a PID stops existing within a few seconds.
func eventuallyGone(pid int) bool {
	deadline := time.After(10 * time.Second)
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		if err := syscall.Kill(pid, syscall.Signal(0)); errors.Is(err, syscall.ESRCH) {
			return true
		}
		select {
		case <-deadline:
			return false
		case <-tick.C:
		}
	}
}
