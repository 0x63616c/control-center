package transcripts

import (
	"fmt"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// EventSink adapts a transcript writer to work.StageEventSink.
//
// It appends exactly one newline per event, unconditionally, and never inspects
// the payload: work.StageEventSink's contract is that each call carries one
// whole event without a terminator, and clients/codex owns satisfying it. A
// client regression that started pre-terminating lines would therefore show up
// as visibly blank-line-padded transcripts rather than pass silently.
//
// A write failure is logged once and swallowed, because work.StageEventSink
// returns nothing deliberately: losing the record of a stage that is already
// burning tokens is cheaper than losing the work. Logged once rather than per
// event, so a volume that went away cannot emit one line per event for an hour.
//
// The returned sink is safe for concurrent use. It serialises on its own mutex
// rather than trusting w, since io.Writer promises nothing about concurrency.
//
// It is only one of the two consumers of a stage's event stream. The other is
// the enclosing activity's heartbeat, which must fan out to both — wiring this
// in as the sole consumer yields an activity that cannot be cancelled for the
// hour a stage may run.
func EventSink(key work.StageKey, w io.Writer, log *slog.Logger) work.StageEventSink {
	var (
		mu       sync.Mutex
		reported atomic.Bool
	)
	return func(rawEvent []byte) {
		line := make([]byte, 0, len(rawEvent)+1)
		line = append(line, rawEvent...)
		line = append(line, '\n')

		mu.Lock()
		n, err := w.Write(line)
		mu.Unlock()

		// A short write with a nil error breaks io.Writer's contract, but a
		// truncated line is a lost record either way, so it is not trusted.
		if err == nil && n != len(line) {
			err = fmt.Errorf("wrote %d of %d bytes", n, len(line))
		}
		if err == nil || !reported.CompareAndSwap(false, true) {
			return
		}
		log.Error("transcript write failed; the stage continues without its record",
			slog.String("stage", key.String()),
			slog.String("error", err.Error()),
		)
	}
}
