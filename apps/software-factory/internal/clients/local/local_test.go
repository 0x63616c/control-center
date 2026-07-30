package local

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codex"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// Execer and FileTransfer are the implementations behind codex's two seams —
// asserted here, not declared here, since interfaces are consumer-side.
var (
	_ codex.PodExecer    = Execer{}
	_ codex.FileTransfer = FileTransfer{}
)

// testSandbox is the only argument every call below carries for interface
// compatibility with codex.PodExecer/codex.FileTransfer, and never inspected:
// a LocalExecer/LocalFileTransfer runs inside the one sandbox pod it already
// is, so there is no second sandbox it could be asked to reach instead.
const testSandbox work.SandboxID = "self"

func TestExecReturnsTheCommandsExitCode(t *testing.T) {
	t.Parallel()

	e := NewExecer()
	var out bytes.Buffer
	code, err := e.Exec(context.Background(), testSandbox, []string{"sh", "-c", "echo hi; exit 3"}, nil, &out, nil)
	if err != nil {
		t.Fatalf("Exec returned an unexpected error: %v", err)
	}
	if code != 3 {
		t.Errorf("Exec code = %d, want 3", code)
	}
	if got := strings.TrimSpace(out.String()); got != "hi" {
		t.Errorf("stdout = %q, want %q", got, "hi")
	}
}

func TestExecPassesStdinThrough(t *testing.T) {
	t.Parallel()

	e := NewExecer()
	var out bytes.Buffer
	if _, err := e.Exec(context.Background(), testSandbox, []string{"cat"}, strings.NewReader("through stdin"), &out, nil); err != nil {
		t.Fatalf("Exec returned an unexpected error: %v", err)
	}
	if out.String() != "through stdin" {
		t.Errorf("stdout = %q, want %q", out.String(), "through stdin")
	}
}

func TestExecWritesStdoutAndStderrSeparately(t *testing.T) {
	t.Parallel()

	e := NewExecer()
	var out, errOut bytes.Buffer
	if _, err := e.Exec(context.Background(), testSandbox, []string{"sh", "-c", "echo on-stdout; echo on-stderr >&2"}, nil, &out, &errOut); err != nil {
		t.Fatalf("Exec returned an unexpected error: %v", err)
	}
	if got := strings.TrimSpace(out.String()); got != "on-stdout" {
		t.Errorf("stdout = %q, want %q", got, "on-stdout")
	}
	if got := strings.TrimSpace(errOut.String()); got != "on-stderr" {
		t.Errorf("stderr = %q, want %q", got, "on-stderr")
	}
}

func TestExecRefusesAnEmptyArgv(t *testing.T) {
	t.Parallel()

	e := NewExecer()
	if _, err := e.Exec(context.Background(), testSandbox, nil, nil, nil, nil); !errors.Is(err, work.ErrPermanent) {
		t.Errorf("Exec error = %v, want it permanent", err)
	}
}

func TestExecReportsATransportFailureSeparatelyFromAnExitCode(t *testing.T) {
	t.Parallel()

	// A binary that does not exist is not "the command ran and failed" —
	// there is no exit code to report, the same distinction k8s.Sandboxes.Exec
	// draws between a transport failure and command evidence.
	e := NewExecer()
	if _, err := e.Exec(context.Background(), testSandbox, []string{"this-binary-does-not-exist-2f8a91"}, nil, nil, nil); err == nil {
		t.Fatal("Exec succeeded against a binary that cannot exist")
	}
}

func TestExecKillsTheProcessOnCancellation(t *testing.T) {
	t.Parallel()

	e := NewExecer()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := e.Exec(ctx, testSandbox, []string{"sleep", "30"}, nil, nil, nil)
		done <- err
	}()

	time.Sleep(100 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("Exec error = %v, want it to wrap context.Canceled", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Exec did not return within 5s of cancellation; the process was not killed")
	}
}

func TestWriteCreatesParentDirectoriesAndWritesTheContent(t *testing.T) {
	t.Parallel()

	f := NewFileTransfer()
	root := t.TempDir()
	target := filepath.Join(root, "run-id", "plan", "prompt.md")

	if err := f.Write(context.Background(), testSandbox, target, []byte("hello"), 0o600); err != nil {
		t.Fatalf("Write returned an unexpected error: %v", err)
	}

	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("reading back the written file: %v", err)
	}
	if string(got) != "hello" {
		t.Errorf("file content = %q, want %q", got, "hello")
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("file mode = %v, want 0600", info.Mode().Perm())
	}
}

func TestWriteRejectsARelativePath(t *testing.T) {
	t.Parallel()

	f := NewFileTransfer()
	if err := f.Write(context.Background(), testSandbox, "relative/path", []byte("x"), 0o600); !errors.Is(err, work.ErrPermanent) {
		t.Errorf("Write error = %v, want it permanent", err)
	}
}

func TestWriteRejectsAModeCarryingBitsBeyondPermission(t *testing.T) {
	t.Parallel()

	f := NewFileTransfer()
	target := filepath.Join(t.TempDir(), "f")
	if err := f.Write(context.Background(), testSandbox, target, []byte("x"), os.ModeSetuid|0o600); !errors.Is(err, work.ErrPermanent) {
		t.Errorf("Write error = %v, want it permanent", err)
	}
}

func TestReadReturnsWhatWriteWrote(t *testing.T) {
	t.Parallel()

	f := NewFileTransfer()
	target := filepath.Join(t.TempDir(), "result.json")
	if err := f.Write(context.Background(), testSandbox, target, []byte(`{"ok":true}`), 0o600); err != nil {
		t.Fatalf("Write returned an unexpected error: %v", err)
	}

	got, err := f.Read(context.Background(), testSandbox, target)
	if err != nil {
		t.Fatalf("Read returned an unexpected error: %v", err)
	}
	if string(got) != `{"ok":true}` {
		t.Errorf("Read = %q, want %q", got, `{"ok":true}`)
	}
}

func TestReadReportsAMissingFileAsErrFileNotFound(t *testing.T) {
	t.Parallel()

	f := NewFileTransfer()
	_, err := f.Read(context.Background(), testSandbox, filepath.Join(t.TempDir(), "never-written.json"))
	if !errors.Is(err, work.ErrFileNotFound) {
		t.Errorf("Read error = %v, want work.ErrFileNotFound", err)
	}
}

func TestReadDoesNotReportNotFoundForAPermissionFailure(t *testing.T) {
	t.Parallel()

	if os.Getuid() == 0 {
		t.Skip("root ignores file permissions, so this can't be exercised as this user")
	}

	dir := t.TempDir()
	target := filepath.Join(dir, "unreadable")
	if err := os.WriteFile(target, []byte("x"), 0o000); err != nil {
		t.Fatalf("seeding an unreadable file: %v", err)
	}

	f := NewFileTransfer()
	_, err := f.Read(context.Background(), testSandbox, target)
	if err == nil {
		t.Fatal("Read succeeded against a file with no read permission")
	}
	if errors.Is(err, work.ErrFileNotFound) {
		t.Error("a permission failure was reported as a missing file")
	}
}
