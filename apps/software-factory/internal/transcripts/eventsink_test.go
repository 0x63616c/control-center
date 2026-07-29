package transcripts

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// scriptedWriter records what it was handed and fails on the calls a test names,
// so framing and failure handling can be observed without a filesystem.
type scriptedWriter struct {
	mu       sync.Mutex
	writes   [][]byte
	failOn   map[int]error
	shortBy  int
	callsSee int
}

func (w *scriptedWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.callsSee++
	w.writes = append(w.writes, append([]byte(nil), p...))
	if err, ok := w.failOn[w.callsSee]; ok {
		return 0, err
	}
	return len(p) - w.shortBy, nil
}

func (w *scriptedWriter) recorded() [][]byte {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([][]byte(nil), w.writes...)
}

// recordingHandler counts the records a sink logs, so "logs the failure once"
// is an assertion rather than a hope.
type recordingHandler struct {
	mu      sync.Mutex
	records []slog.Record
}

func (h *recordingHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h *recordingHandler) Handle(_ context.Context, r slog.Record) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.records = append(h.records, r.Clone())
	return nil
}

func (h *recordingHandler) WithAttrs([]slog.Attr) slog.Handler { return h }

func (h *recordingHandler) WithGroup(string) slog.Handler { return h }

// errorsLogged returns the messages and attributes of every ERROR record.
func (h *recordingHandler) errorsLogged() []slog.Record {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []slog.Record
	for _, r := range h.records {
		if r.Level >= slog.LevelError {
			out = append(out, r)
		}
	}
	return out
}

func newEventSink(t *testing.T, w *scriptedWriter) (work.StageEventSink, *recordingHandler, work.StageKey) {
	t.Helper()
	h := &recordingHandler{}
	key := work.StageKey{Ticket: 312, RunID: "0198c2f1", Stage: work.StageReview}
	return EventSink(key, w, slog.New(h)), h, key
}

func TestEventSinkFramesEachEventAsOneNewlineTerminatedLine(t *testing.T) {
	t.Parallel()

	w := &scriptedWriter{}
	sink, _, _ := newEventSink(t, w)

	sink([]byte(`{"type":"a"}`))
	sink([]byte(`{"type":"b"}`))

	got := w.recorded()
	if len(got) != 2 {
		t.Fatalf("the writer saw %d writes, want one per event", len(got))
	}
	for i, want := range []string{"{\"type\":\"a\"}\n", "{\"type\":\"b\"}\n"} {
		if string(got[i]) != want {
			t.Errorf("write %d = %q, want %q", i, got[i], want)
		}
	}
}

func TestEventSinkTreatsAShortWriteAsAFailedEvent(t *testing.T) {
	t.Parallel()

	w := &scriptedWriter{shortBy: 1}
	sink, h, _ := newEventSink(t, w)

	sink([]byte(`{"type":"a"}`))

	if got := h.errorsLogged(); len(got) != 1 {
		t.Errorf("logged %d errors, want 1 — a truncated line is a lost record, not a success", len(got))
	}
}

func TestEventSinkKeepsStreamingAfterAFailedWriteAndLogsTheFailureOnce(t *testing.T) {
	t.Parallel()

	wedged := errors.New("transcript volume went away")
	w := &scriptedWriter{failOn: map[int]error{2: wedged, 3: wedged}}
	sink, h, key := newEventSink(t, w)

	for _, event := range []string{"a", "b", "c", "d"} {
		sink([]byte(event))
	}

	got := w.recorded()
	if len(got) != 4 {
		t.Fatalf("the writer saw %d events, want 4 — a failed write must not abort the stream", len(got))
	}
	if string(got[3]) != "d\n" {
		t.Errorf("the last event reached the writer as %q, want %q", got[3], "d\n")
	}

	logged := h.errorsLogged()
	if len(logged) != 1 {
		t.Fatalf("logged %d errors, want exactly 1 — a dead mount must not emit one line per event", len(logged))
	}
	var named bool
	logged[0].Attrs(func(a slog.Attr) bool {
		if strings.Contains(a.Value.String(), key.String()) {
			named = true
		}
		return true
	})
	if !named {
		t.Errorf("the logged error does not name %q; a transcript failure must say whose it was", key)
	}
}

func TestEventSinkServesEventsArrivingFromMoreThanOneGoroutine(t *testing.T) {
	t.Parallel()

	const goroutines, eventsEach = 8, 50

	// Every write fails, so the log-once latch is exercised by all of them at
	// once. -race is the assertion that the latch and the writer are safe.
	w := &scriptedWriter{failOn: map[int]error{}}
	for i := 1; i <= goroutines*eventsEach; i++ {
		w.failOn[i] = errors.New("transcript volume went away")
	}
	sink, h, _ := newEventSink(t, w)

	var wg sync.WaitGroup
	start := make(chan struct{})
	for range goroutines {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for range eventsEach {
				sink([]byte(`{"type":"a"}`))
			}
		}()
	}
	close(start)
	wg.Wait()

	if got := len(w.recorded()); got != goroutines*eventsEach {
		t.Errorf("the writer saw %d events, want %d", got, goroutines*eventsEach)
	}
	if got := h.errorsLogged(); len(got) != 1 {
		t.Errorf("logged %d errors, want exactly 1", len(got))
	}
}
