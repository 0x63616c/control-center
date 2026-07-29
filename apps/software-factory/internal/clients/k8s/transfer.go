package k8s

import (
	"archive/tar"
	"bytes"
	"context"
	"fmt"
	"io/fs"
	"path"
	"strings"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// dirMode is the mode every parent directory a Write creates is given.
//
// Never the file's mode: with a credential at 0600, an inherited mode leaves
// the directory non-traversable and every later access to the stage's files
// fails with a permission error that looks nothing like its cause.
const dirMode = 0o755

// Write puts content into the sandbox at path, with the requested mode,
// creating any parent directories it needs.
//
// It is one exec streaming a tar archive, because a tar header carries the
// mode: the alternative is a write followed by a chmod, which leaves a window
// in which a credential file is world-readable. There is no shell anywhere on
// this path — argv only, end to end.
func (s *Sandboxes) Write(ctx context.Context, sandbox work.SandboxID, filePath string, content []byte, mode fs.FileMode) error {
	clean, err := sandboxPath(sandbox, "writing", filePath)
	if err != nil {
		return err
	}
	if mode&^fs.ModePerm != 0 {
		return fmt.Errorf("writing %s to sandbox %s: mode %v carries bits that mean nothing for a file: %w",
			clean, sandbox, mode, work.ErrPermanent)
	}

	stream, err := tarStream(clean, content, mode, s.clk.Now().UTC())
	if err != nil {
		return fmt.Errorf("writing %s to sandbox %s: %w: %w", clean, sandbox, err, work.ErrPermanent)
	}

	// Relative header names extracted with -C /: GNU tar strips a leading
	// slash and warns, busybox tar does not, and relative names are
	// unambiguous under both.
	argv := []string{"tar", "-xf", "-", "-C", "/"}
	var stderr bytes.Buffer
	code, err := s.exec(ctx, sandbox, argv, bytes.NewReader(stream), nil, &stderr)
	if err != nil {
		return fmt.Errorf("writing %s to sandbox %s: %w", clean, sandbox, err)
	}
	if code != 0 {
		return exitCodeError(sandbox, fmt.Sprintf("writing %s", clean), argv, code, stderr.String())
	}

	s.logger.DebugContext(ctx, "wrote a file into a sandbox",
		"sandbox", sandbox, "path", clean, "bytes", len(content), "mode", mode.String())
	return nil
}

// tarStream builds the archive Write extracts, with one directory entry per
// parent in root-to-leaf order so no caller needs a mkdir seam. The sandbox
// root is the one parent it never describes; it is already there.
//
// Modification times come from the injected clock, which makes the stream
// byte-deterministic — a test can compare two of them — and keeps time.Now out
// of a package that is banned from calling it.
func tarStream(filePath string, content []byte, mode fs.FileMode, modTime time.Time) ([]byte, error) {
	rel := strings.TrimPrefix(filePath, "/")

	var out bytes.Buffer
	w := tar.NewWriter(&out)
	for _, dir := range ancestors(path.Dir(rel)) {
		if "/"+dir == work.SandboxRoot {
			// The mount point, never ours to chmod: under fsGroup the kubelet
			// leaves it root-owned, and an entry for it makes GNU tar's delayed
			// set-stat fail with EPERM and exit 2 on every Write.
			continue
		}
		if err := w.WriteHeader(&tar.Header{
			Typeflag: tar.TypeDir,
			Name:     dir + "/",
			Mode:     dirMode,
			ModTime:  modTime,
		}); err != nil {
			return nil, fmt.Errorf("building the tar entry for directory %q: %w", dir, err)
		}
	}
	if err := w.WriteHeader(&tar.Header{
		Typeflag: tar.TypeReg,
		Name:     rel,
		Mode:     int64(mode.Perm()),
		Size:     int64(len(content)),
		ModTime:  modTime,
	}); err != nil {
		return nil, fmt.Errorf("building the tar entry for %q: %w", rel, err)
	}
	if _, err := w.Write(content); err != nil {
		return nil, fmt.Errorf("writing the tar body for %q: %w", rel, err)
	}
	if err := w.Close(); err != nil {
		return nil, fmt.Errorf("closing the tar stream for %q: %w", rel, err)
	}
	return out.Bytes(), nil
}

// ancestors lists a relative directory's path prefixes, root first, so tar
// creates each parent before the child that needs it.
func ancestors(dir string) []string {
	if dir == "." || dir == "" {
		return nil
	}
	parts := strings.Split(dir, "/")
	out := make([]string, 0, len(parts))
	for i := range parts {
		out = append(out, strings.Join(parts[:i+1], "/"))
	}
	return out
}

// sandboxPath rejects anything Write and Read have no business touching, and
// returns the cleaned absolute path.
//
// The confinement is what the ownership invariant behind Read's `test -e`
// depends on: every path either call touches lives under the sandbox root,
// owned by the one uid the container runs as, so an exit 1 from the probe
// means absent rather than unreadable.
func sandboxPath(sandbox work.SandboxID, op, filePath string) (string, error) {
	if filePath == "" || !strings.HasPrefix(filePath, "/") {
		return "", fmt.Errorf("%s %q in sandbox %s: the path must be absolute, so nothing resolves against an unknown working directory: %w",
			op, filePath, sandbox, work.ErrPermanent)
	}
	clean := path.Clean(filePath)
	if !strings.HasPrefix(clean, work.SandboxRoot+"/") {
		return "", fmt.Errorf("%s %q in sandbox %s: it is outside the sandbox root %s: %w",
			op, filePath, sandbox, work.SandboxRoot, work.ErrPermanent)
	}
	return clean, nil
}

// Read returns the bytes of a file in the sandbox.
//
// Two execs, deliberately. A probe answers whether the path exists, and only
// then is it read: absence is the signal the resume decision is built on, so it
// must be distinguishable from every other failure. `test -e` conflates ENOENT
// with EACCES, which is why only exits 0 and 1 are read as an answer at all —
// anything else, 126 and 127 among them, is an error and never absence.
//
// It returns an error satisfying errors.Is(err, work.ErrFileNotFound) when, and
// only when, the file is absent.
func (s *Sandboxes) Read(ctx context.Context, sandbox work.SandboxID, filePath string) ([]byte, error) {
	clean, err := sandboxPath(sandbox, "reading", filePath)
	if err != nil {
		return nil, err
	}

	probe := []string{"test", "-e", clean}
	code, err := s.exec(ctx, sandbox, probe, nil, nil, nil)
	if err != nil {
		return nil, fmt.Errorf("probing for %s in sandbox %s: %w", clean, sandbox, err)
	}
	switch code {
	case 0:
	case 1:
		s.logger.DebugContext(ctx, "a sandbox file is absent", "sandbox", sandbox, "path", clean, "absent", true)
		return nil, fmt.Errorf("probing for %s in sandbox %s: %w", clean, sandbox, work.ErrFileNotFound)
	default:
		return nil, exitCodeError(sandbox, fmt.Sprintf("probing for %s", clean), probe, code, "")
	}

	out := &cappedWriter{limit: s.opts.maxReadBytes}
	argv := []string{"cat", clean}
	var stderr bytes.Buffer
	code, err = s.exec(ctx, sandbox, argv, nil, out, &stderr)
	if err != nil {
		return nil, fmt.Errorf("reading %s from sandbox %s: %w", clean, sandbox, err)
	}
	if code != 0 {
		return nil, exitCodeError(sandbox, fmt.Sprintf("reading %s", clean), argv, code, stderr.String())
	}

	s.logger.DebugContext(ctx, "read a file from a sandbox", "sandbox", sandbox, "path", clean, "bytes", out.buf.Len())
	return out.buf.Bytes(), nil
}

// cappedWriter accepts up to limit bytes and fails the write that would exceed
// it.
//
// Failing rather than truncating is the point. remotecommand propagates a
// stdout write error and tears the stream down, so the remote cat stops and the
// worker never buffers more than the cap; an io.LimitReader would return EOF at
// the limit instead, which is a silently truncated result file passed off as a
// complete one.
type cappedWriter struct {
	buf   bytes.Buffer
	limit int64
}

// Write appends p, or fails if that would pass the cap.
//
// The count it returns on failure is what it actually kept, not zero: io.Writer
// requires n to describe the bytes written, and an io.Copy over this would
// otherwise mis-account the transfer.
func (w *cappedWriter) Write(p []byte) (int, error) {
	if int64(w.buf.Len())+int64(len(p)) > w.limit {
		room := w.limit - int64(w.buf.Len())
		if room > 0 {
			w.buf.Write(p[:room])
		} else {
			room = 0
		}
		return int(room), fmt.Errorf("the file is larger than the %d-byte read limit", w.limit)
	}
	return w.buf.Write(p)
}
