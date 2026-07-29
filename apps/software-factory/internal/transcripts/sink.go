// Package transcripts stores the raw event stream of a stage attempt on the
// worker's transcript volume, and frames it as JSONL.
//
// Transcripts are stored rather than logged because the cluster's log retention
// is far shorter than the time you might want to ask why a PR was proposed.
package transcripts

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// ErrInvalidKey reports a StageKey that cannot name a transcript.
var ErrInvalidKey = errors.New("invalid stage key")

// Sink writes stage transcripts under one root directory.
//
// Construct exactly one per process, at the composition root. Activities retry,
// and a retry can begin while the previous attempt is still streaming, so two
// writers can hold the same StageKey at once — StageKey carries no attempt
// number. Sink closes that hazard by refcounting a single descriptor per path,
// which is in-process state: a second Sink over the same root, or a second
// worker replica, reintroduces exactly what it exists to prevent.
type Sink struct {
	root string

	mu   sync.Mutex
	open map[string]*handle
}

// handle is one open transcript file, shared by every writer that currently
// holds its path. Writes serialise on mu so overlapping attempts interleave at
// line granularity rather than racing the descriptor's offset.
type handle struct {
	file *os.File

	mu   sync.Mutex
	refs int
}

// New returns a Sink writing under root, the mount point of the transcript
// volume.
//
// It stats root so a misconfigured mount stops the worker at startup with a
// clear message rather than at the first stage. A stat rather than a write
// probe: the probe adds failure modes the first real Open reports just as
// clearly. On a hard NFS mount with an unreachable server this blocks
// uninterruptibly, which is why the volume must be mounted soft with bounded
// timeo and retrans.
func New(root string) (*Sink, error) {
	info, err := os.Stat(root)
	if err != nil {
		return nil, fmt.Errorf("checking the transcript root %q: %w", root, err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("the transcript root %q is not a directory", root)
	}
	return &Sink{root: root, open: make(map[string]*handle)}, nil
}

// Open creates the attempt's transcript and returns an appending writer.
//
// It is safe for concurrent use, including two overlapping attempts of one key:
// they share one descriptor, so every line stays whole and present, and the two
// attempts interleave in wall-clock order. StageResult.ThreadID is what
// separates them on read.
//
// The file is created before the first event, so an empty transcript is itself
// evidence that a stage emitted nothing. Existing content is appended to, never
// truncated — a retry must not erase the attempt it replaced.
//
// Only the last Close returns the file's close error; earlier closers get nil,
// and a repeated Close of one writer is a no-op returning nil.
//
// ctx is the interface's and unused: opening a local file is not cancellable.
func (s *Sink) Open(ctx context.Context, key work.StageKey) (io.WriteCloser, error) {
	if err := validate(key); err != nil {
		return nil, err
	}
	path := filepath.Join(s.root, filepath.FromSlash(key.TranscriptPath()))

	s.mu.Lock()
	defer s.mu.Unlock()

	if h, ok := s.open[path]; ok {
		h.refs++
		return &writer{sink: s, path: path, handle: h}, nil
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return nil, fmt.Errorf("creating the transcript directory for %s: %w", key, err)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o640)
	if err != nil {
		return nil, fmt.Errorf("opening the transcript for %s: %w", key, err)
	}
	h := &handle{file: f, refs: 1}
	s.open[path] = h
	return &writer{sink: s, path: path, handle: h}, nil
}

// release drops one reference, closing the file and forgetting it at zero.
func (s *Sink) release(path string, h *handle) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	h.refs--
	if h.refs > 0 {
		return nil
	}
	delete(s.open, path)

	// Taking the write mutex makes "no write is in flight" true at the moment
	// the descriptor goes away. Lock order is always sink then handle.
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := h.file.Close(); err != nil {
		return fmt.Errorf("closing the transcript %s: %w", path, err)
	}
	return nil
}

// validate rejects a key that cannot name a transcript.
//
// path.Join drops empty elements, so an empty RunID collapses
// <ticket>/<run>/<stage>.jsonl to <ticket>/<stage>.jsonl and every run of that
// ticket silently shares one file — destroying the property the path exists
// for. Parsing here is cheaper than discovering it in a forensic read months
// later.
func validate(key work.StageKey) error {
	switch {
	case key.Ticket <= 0:
		return fmt.Errorf("%w: ticket number must be positive: %s", ErrInvalidKey, key)
	case key.RunID == "":
		return fmt.Errorf("%w: run id must not be empty: %s", ErrInvalidKey, key)
	case key.Stage == "":
		return fmt.Errorf("%w: stage must not be empty: %s", ErrInvalidKey, key)
	}
	return nil
}

// writer is one holder's view of a shared transcript handle.
type writer struct {
	sink   *Sink
	path   string
	handle *handle
	closed atomic.Bool
}

// Write appends one event to the transcript, unbuffered.
//
// Unbuffered is a requirement, not an oversight: a stage runs for up to an
// hour, and a buffer would withhold its events from anyone watching it for
// minutes at a time.
func (w *writer) Write(p []byte) (int, error) {
	if w.closed.Load() {
		return 0, fmt.Errorf("writing to the closed transcript %s", w.path)
	}
	w.handle.mu.Lock()
	defer w.handle.mu.Unlock()
	n, err := w.handle.file.Write(p)
	if err != nil {
		return n, fmt.Errorf("appending to the transcript %s: %w", w.path, err)
	}
	return n, nil
}

// Close drops this holder's reference. The file survives until the last holder
// closes, so a retry cannot pull the descriptor out from under the attempt it
// overlapped.
func (w *writer) Close() error {
	if !w.closed.CompareAndSwap(false, true) {
		return nil
	}
	return w.sink.release(w.path, w.handle)
}
