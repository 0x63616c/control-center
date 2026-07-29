package k8s

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"reflect"
	"strings"
	"testing"

	"k8s.io/client-go/kubernetes/fake"
	utilexec "k8s.io/client-go/util/exec"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

const testPath = "/work/3f1c2a7e/plan/prompt.md"

// tarEntries decodes what Write streamed into the extract command's stdin.
type tarEntry struct {
	name     string
	typeflag byte
	mode     int64
	body     string
}

func decodeTar(t *testing.T, stream []byte) []tarEntry {
	t.Helper()
	var out []tarEntry
	r := tar.NewReader(bytes.NewReader(stream))
	for {
		h, err := r.Next()
		if errors.Is(err, io.EOF) {
			return out
		}
		if err != nil {
			t.Fatalf("decoding the tar stream: %v", err)
		}
		body, err := io.ReadAll(r)
		if err != nil {
			t.Fatalf("reading a tar entry body: %v", err)
		}
		out = append(out, tarEntry{name: h.Name, typeflag: h.Typeflag, mode: h.Mode, body: string(body)})
	}
}

func TestWriteWritesAFileAsATarStreamCarryingTheRequestedMode(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{{}}}
	s, _ := newTestSandboxes(t, str, runningPod())

	if err := s.Write(context.Background(), testSandbox, testPath, []byte("hello"), 0o600); err != nil {
		t.Fatalf("Write returned an unexpected error: %v", err)
	}

	entries := decodeTar(t, str.observed()[0].stdin)
	last := entries[len(entries)-1]
	if last.typeflag != tar.TypeReg {
		t.Errorf("last entry typeflag = %q, want a regular file", last.typeflag)
	}
	// The mode is why this is tar rather than tee: a second chmod exec would
	// leave a window where a credential file is world-readable.
	if last.mode != 0o600 {
		t.Errorf("file mode = %#o, want 0600", last.mode)
	}
	if last.body != "hello" {
		t.Errorf("file body = %q, want %q", last.body, "hello")
	}
}

func TestWriteWritesTarHeaderNamesRelativeToTheExtractionRoot(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{{}}}
	s, _ := newTestSandboxes(t, str, runningPod())
	if err := s.Write(context.Background(), testSandbox, testPath, []byte("hello"), 0o644); err != nil {
		t.Fatalf("Write returned an unexpected error: %v", err)
	}

	call := str.observed()[0]
	// GNU tar strips a leading / and warns; busybox tar differs. Relative
	// names extracted with -C / are unambiguous under both.
	if want := []string{"tar", "-xf", "-", "-C", "/"}; !reflect.DeepEqual(call.argv[4:], want) {
		t.Errorf("extract argv = %v, want %v", call.argv[4:], want)
	}
	for _, e := range decodeTar(t, call.stdin) {
		if strings.HasPrefix(e.name, "/") {
			t.Errorf("tar entry %q is absolute", e.name)
		}
	}
	last := decodeTar(t, call.stdin)
	if got := last[len(last)-1].name; got != "work/3f1c2a7e/plan/prompt.md" {
		t.Errorf("file entry name = %q, want %q", got, "work/3f1c2a7e/plan/prompt.md")
	}
}

func TestWriteCreatesTheParentDirectoriesTraversable(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{{}}}
	s, _ := newTestSandboxes(t, str, runningPod())
	// 0600 on the file: an inherited directory mode would make every parent
	// non-traversable and every later access to the stage's files fail.
	if err := s.Write(context.Background(), testSandbox, testPath, []byte("hello"), 0o600); err != nil {
		t.Fatalf("Write returned an unexpected error: %v", err)
	}

	entries := decodeTar(t, str.observed()[0].stdin)
	var dirs []string
	for _, e := range entries[:len(entries)-1] {
		if e.typeflag != tar.TypeDir {
			t.Errorf("entry %q is not a directory but precedes the file", e.name)
		}
		if e.mode != 0o755 {
			t.Errorf("directory %q mode = %#o, want 0755", e.name, e.mode)
		}
		if !strings.HasSuffix(e.name, "/") {
			t.Errorf("directory entry %q does not end in a slash", e.name)
		}
		dirs = append(dirs, e.name)
	}
	// The sandbox root is absent deliberately — see
	// TestWriteNeverEmitsATarEntryForTheSandboxRoot.
	want := []string{"work/3f1c2a7e/", "work/3f1c2a7e/plan/"}
	if !reflect.DeepEqual(dirs, want) {
		t.Errorf("directory entries = %v, want %v in root-to-leaf order", dirs, want)
	}
}

func TestWriteNeverEmitsATarEntryForTheSandboxRoot(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{{}}}
	s, _ := newTestSandboxes(t, str, runningPod())
	if err := s.Write(context.Background(), testSandbox, testPath, []byte("hello"), 0o600); err != nil {
		t.Fatalf("Write returned an unexpected error: %v", err)
	}

	// The sandbox root is an emptyDir mount point. Under fsGroup the kubelet
	// leaves it root-owned, so GNU tar's delayed set-stat chmods it at the end
	// of extraction, gets EPERM and exits 2 — failing every single Write.
	root := strings.TrimPrefix(work.SandboxRoot, "/") + "/"
	for _, e := range decodeTar(t, str.observed()[0].stdin) {
		if e.name == root {
			t.Errorf("the tar stream carries an entry for the sandbox root %q, which the sandbox uid does not own", e.name)
		}
	}
}

func TestWriteStampsTarEntriesFromTheInjectedClock(t *testing.T) {
	t.Parallel()

	first := &scriptedStreamer{answers: []answer{{}}}
	second := &scriptedStreamer{answers: []answer{{}}}
	a, _ := newTestSandboxes(t, first, runningPod())
	b, _ := newTestSandboxes(t, second, runningPod())

	for _, s := range []*Sandboxes{a, b} {
		if err := s.Write(context.Background(), testSandbox, testPath, []byte("hello"), 0o600); err != nil {
			t.Fatalf("Write returned an unexpected error: %v", err)
		}
	}
	// Byte-identical, which is only true if nothing here reads the wall clock.
	if !bytes.Equal(first.observed()[0].stdin, second.observed()[0].stdin) {
		t.Error("two writes of one file produced different tar streams; something read the real clock")
	}
}

func TestWriteFailsWhenTheExtractCommandExitsNonZeroQuotingStderr(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{{
		err:    utilexec.CodeExitError{Err: errors.New("command terminated"), Code: 2},
		stderr: "tar: /work: Cannot write: No space left on device",
	}}}
	s, _ := newTestSandboxes(t, str, runningPod())

	err := s.Write(context.Background(), testSandbox, testPath, []byte("hello"), 0o600)
	if err == nil {
		t.Fatal("Write succeeded on a tar that exited 2")
	}
	if !strings.Contains(err.Error(), "No space left on device") {
		t.Errorf("Write error %q drops tar's stderr, which is the only evidence of what went wrong", err)
	}
}

func TestWriteReportsAMissingTarAsPermanent(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{{err: utilexec.CodeExitError{Err: errors.New("command terminated"), Code: 127}}}}
	s, _ := newTestSandboxes(t, str, runningPod())

	if err := s.Write(context.Background(), testSandbox, testPath, []byte("x"), 0o600); !errors.Is(err, work.ErrPermanent) {
		t.Errorf("Write error = %v, want it permanent: the sandbox image is missing tar", err)
	}
}

func TestTransferRefusesAPathOutsideTheSandboxRoot(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		path string
	}{
		{name: "a relative path", path: "work/x"},
		{name: "a path outside the sandbox root", path: "/etc/passwd"},
		{name: "a path that escapes the sandbox root", path: "/work/../etc/passwd"},
		{name: "the sandbox root itself", path: work.SandboxRoot},
		{name: "an empty path", path: ""},
		{name: "a path that only looks like the root", path: "/workshop/x"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			str := &scriptedStreamer{answers: []answer{{}, {}}}
			s, _ := newTestSandboxes(t, str, runningPod())

			if err := s.Write(context.Background(), testSandbox, tc.path, []byte("x"), 0o600); !errors.Is(err, work.ErrPermanent) {
				t.Errorf("Write(%q) error = %v, want it permanent", tc.path, err)
			}
			if _, err := s.Read(context.Background(), testSandbox, tc.path); !errors.Is(err, work.ErrPermanent) {
				t.Errorf("Read(%q) error = %v, want it permanent", tc.path, err)
			}
			if calls := str.observed(); len(calls) != 0 {
				t.Errorf("a rejected path still reached the sandbox: %v", calls)
			}
		})
	}
}

func TestWriteNeverPutsACredentialInAnErrorMessage(t *testing.T) {
	t.Parallel()

	const secret = "ghs_s3cr3tinstallationtoken"
	str := &scriptedStreamer{answers: []answer{{
		err:    utilexec.CodeExitError{Err: errors.New("command terminated"), Code: 2},
		stderr: "tar: cannot write",
	}}}
	s, logs := newTestSandboxes(t, str, runningPod())

	err := s.Write(context.Background(), testSandbox, "/work/3f1c2a7e/.git-credentials",
		[]byte(work.NewCredential(secret).Reveal()), 0o600)
	if err == nil {
		t.Fatal("Write succeeded")
	}
	if strings.Contains(err.Error(), secret) {
		t.Error("the credential appeared in the error message")
	}
	if strings.Contains(logs.String(), secret) {
		t.Error("the credential appeared in the logs")
	}
}

func TestReadReturnsTheFilesBytes(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{{}, {stdout: `{"plan":"ok"}`}}}
	s, _ := newTestSandboxes(t, str, runningPod())

	got, err := s.Read(context.Background(), testSandbox, testPath)
	if err != nil {
		t.Fatalf("Read returned an unexpected error: %v", err)
	}
	if string(got) != `{"plan":"ok"}` {
		t.Errorf("Read = %q, want %q", got, `{"plan":"ok"}`)
	}
}

func TestReadProbesBeforeItReads(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{{}, {stdout: "x"}}}
	s, _ := newTestSandboxes(t, str, runningPod())
	if _, err := s.Read(context.Background(), testSandbox, testPath); err != nil {
		t.Fatalf("Read returned an unexpected error: %v", err)
	}

	calls := str.observed()
	if len(calls) != 2 {
		t.Fatalf("streamer saw %d calls, want 2: a probe and a read", len(calls))
	}
	// Order is load-bearing: deriving absence from cat's exit 1 would conflate
	// it with permission denied.
	if want := []string{"test", "-e", testPath}; !reflect.DeepEqual(calls[0].argv[4:], want) {
		t.Errorf("first call argv = %v, want %v", calls[0].argv[4:], want)
	}
	if want := []string{"cat", testPath}; !reflect.DeepEqual(calls[1].argv[4:], want) {
		t.Errorf("second call argv = %v, want %v", calls[1].argv[4:], want)
	}
}

func TestReadReportsAMissingFileAsErrFileNotFound(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{{err: utilexec.CodeExitError{Err: errors.New("command terminated"), Code: 1}}}}
	s, _ := newTestSandboxes(t, str, runningPod())

	_, err := s.Read(context.Background(), testSandbox, testPath)
	if !errors.Is(err, work.ErrFileNotFound) {
		t.Fatalf("Read error = %v, want work.ErrFileNotFound", err)
	}
	if calls := str.observed(); len(calls) != 1 {
		t.Errorf("streamer saw %d calls, want 1: an absent file is not read", len(calls))
	}
}

func TestReadDoesNotReportNotFoundWhenTheProbeItselfFails(t *testing.T) {
	t.Parallel()

	// The most load-bearing test here. A false "missing" makes codex.Decide
	// re-run a finished stage, and the owner pays for it twice.
	str := &scriptedStreamer{answers: []answer{{err: io.ErrUnexpectedEOF}}}
	s, _ := newTestSandboxes(t, str, runningPod())

	_, err := s.Read(context.Background(), testSandbox, testPath)
	if err == nil {
		t.Fatal("Read succeeded when the probe could not be carried out")
	}
	if errors.Is(err, work.ErrFileNotFound) {
		t.Error("a probe that could not be carried out was reported as a missing file")
	}
}

func TestReadDoesNotReportNotFoundWhenTheProbeCommandIsMissingFromTheImage(t *testing.T) {
	t.Parallel()

	// test -e conflates ENOENT with EACCES, so only exits 0 and 1 are ever read
	// as an answer. 126 and 127 are what a sandbox image missing `test`
	// produces, and they are never absence.
	for _, code := range []int{126, 127, 2, 3} {
		t.Run(string(rune('0'+code/100))+"xx", func(t *testing.T) {
			t.Parallel()
			str := &scriptedStreamer{answers: []answer{{err: utilexec.CodeExitError{Err: errors.New("command terminated"), Code: code}}}}
			s, _ := newTestSandboxes(t, str, runningPod())

			_, err := s.Read(context.Background(), testSandbox, testPath)
			if errors.Is(err, work.ErrFileNotFound) {
				t.Fatalf("probe exit %d was reported as a missing file", code)
			}
			if err == nil {
				t.Fatalf("probe exit %d was reported as success", code)
			}
		})
	}
}

func TestReadDoesNotReportNotFoundWhenTheReadFailsAfterASuccessfulProbe(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{
		{},
		{err: utilexec.CodeExitError{Err: errors.New("command terminated"), Code: 1}, stderr: "cat: permission denied"},
	}}
	s, _ := newTestSandboxes(t, str, runningPod())

	_, err := s.Read(context.Background(), testSandbox, testPath)
	if err == nil {
		t.Fatal("Read succeeded when cat exited 1")
	}
	if errors.Is(err, work.ErrFileNotFound) {
		t.Error("a failed read after a successful probe was reported as a missing file")
	}
	if !strings.Contains(err.Error(), "permission denied") {
		t.Errorf("Read error %q drops cat's stderr", err)
	}
}

func TestReadFailsRatherThanBufferingAFileOverTheReadLimit(t *testing.T) {
	t.Parallel()

	var stdoutErr error
	str := &scriptedStreamer{answers: []answer{
		{},
		{stdout: strings.Repeat("a", 4096), stdoutErr: &stdoutErr},
	}}
	s, err := newSandboxes(fake.NewSimpleClientset(runningPod()), str, "software-factory", discardLogger(), testClock(), WithMaxReadBytes(1024))
	if err != nil {
		t.Fatalf("newSandboxes returned an unexpected error: %v", err)
	}

	got, err := s.Read(context.Background(), testSandbox, testPath)
	if err == nil {
		t.Fatal("Read succeeded on a file over the limit; io.LimitReader would have truncated it silently")
	}
	if !strings.Contains(err.Error(), "1024") {
		t.Errorf("Read error %q does not name the limit", err)
	}
	if len(got) > 1024 {
		t.Errorf("Read returned %d bytes despite a 1024-byte cap", len(got))
	}
	// The stream must be torn down, not drained: the worker never holds more
	// than the cap even for a file far larger than it.
	if stdoutErr == nil {
		t.Error("the stdout writer did not report an error, so the remote cat was never stopped")
	}
}

func TestReadReportsAnAbsentFileAtDebugWithoutClaimingBytes(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{{err: utilexec.CodeExitError{Err: errors.New("command terminated"), Code: 1}}}}
	s, logs := newTestSandboxes(t, str, runningPod())
	if _, err := s.Read(context.Background(), testSandbox, testPath); !errors.Is(err, work.ErrFileNotFound) {
		t.Fatalf("Read error = %v, want work.ErrFileNotFound", err)
	}
	if !strings.Contains(logs.String(), `"absent":true`) {
		t.Errorf("logs %q do not record the absence, which is the decision the resume is built on", logs.String())
	}
}

func TestWriteRefusesAModeWithNonPermissionBits(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{{}}}
	s, _ := newTestSandboxes(t, str, runningPod())

	// fs.ModeDir and friends have no meaning for a file this writes, and
	// silently masking them would hide a caller's mistake.
	if err := s.Write(context.Background(), testSandbox, testPath, []byte("x"), fs.ModeDir|0o755); !errors.Is(err, work.ErrPermanent) {
		t.Errorf("Write error = %v, want it permanent", err)
	}
}
