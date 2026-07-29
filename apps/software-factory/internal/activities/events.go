package activities

import (
	"context"
	"io"
	"log/slog"
	"sync/atomic"

	"go.temporal.io/sdk/activity"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/transcripts"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// StageEvents is the sink a stage streams its events into: one stream, two
// consumers.
//
// The transcript keeps the bytes, because the cluster's log retention is far
// shorter than the time you might want to ask why a PR was proposed. The
// heartbeat keeps the activity alive and cancellable, because a stage may
// legitimately run for an hour and Temporal cannot otherwise tell that from a
// dead one. Wiring in either alone is a quiet failure: the transcript alone
// yields an uncancellable black box, and the heartbeat alone loses the record.
//
// It builds the transcript sink itself rather than accepting one, so the two
// consumers cannot be assembled wrongly or one of them left out — the caller
// opens the writer, and this is the only way that writer becomes a sink.
//
// ctx must be an activity context; this reports liveness through it. Nothing
// else in this service may call it.
func StageEvents(ctx context.Context, key work.StageKey, transcript io.Writer, log *slog.Logger) work.StageEventSink {
	toTranscript := transcripts.EventSink(key, transcript, log)

	var events atomic.Int64
	return func(rawEvent []byte) {
		// Liveness first. A transcript writer that blocks — a volume that went
		// away, a full disk — must not be able to silence the heartbeat, or a
		// lost record becomes an activity killed an hour into its work.
		//
		// Per event, not on a timer: the SDK throttles heartbeats itself
		// against the activity's heartbeat timeout, so a chatty stage costs
		// one cheap call per event rather than one request per event, and a
		// quiet one is reported dead exactly when it should be.
		//
		// The details are a count and nothing else. Heartbeat details are
		// persisted to workflow history for the namespace's whole retention,
		// and this stream carries the model's output, which carries whatever
		// an issue author wrote. The transcript is where the payload goes.
		activity.RecordHeartbeat(ctx, events.Add(1))

		toTranscript(rawEvent)
	}
}
