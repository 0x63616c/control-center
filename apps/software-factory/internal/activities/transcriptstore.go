package activities

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// gzipCompression names the codec PersistTranscriptToStore compresses with.
// It is stored alongside every row's bytes, per ADR-0012 ("Transcripts move
// into Postgres"), so a future change of codec can never orphan an old one:
// a reader always knows which decompressor a given row needs.
const gzipCompression = "gzip"

// TranscriptStore is the store surface TranscriptRecordingActivities needs:
// just enough to persist an Attempt's transcript. It is satisfied by
// *store.Store and, for tests, by storefake's fake.
type TranscriptStore interface {
	store.TranscriptWriter
}

// TranscriptRecordingActivities persists one Attempt's whole raw event
// stream into ADR-0012's Postgres store, compressed, checksummed, and sized
// on the receiving side.
//
// It is a distinct activity from the existing PersistTranscript, not a
// change to it. PersistTranscript is shared: it is called directly from
// internal/workflows/workticket.go, the currently-running,
// GitHub-issue-driven workflow, and ADR-0012's Cutover section is explicit
// that "the existing pair is not modified." Repointing PersistTranscript's
// existing NFS write at Postgres instead — what software-factory#550's own
// ticket body asks for ("point it at the database, that is the change") —
// would do exactly that: every in-flight GitHub-driven run's transcript
// write would target a `transcript` row whose foreign key requires an
// Attempt, and no Attempt is ever recorded for a GitHub-driven run (see
// RecordingActivities' own doc comment for why: run.ticket_id has no
// Ticket to point at, and ADR-0012 forbids ever bridging one). That
// overrides this ticket's "do not rebuild the seam" instruction, per this
// repo's own precedence rule — see the linked ADR-0012 amendment issue.
//
// This type, like RecordingActivities, is fully tested and left
// unregistered: software-factory#558's Ticket-driven workflow is its one
// intended caller, and the existing PersistTranscript and its NFS sink are
// untouched, so the currently-running pipeline's transcript persistence
// keeps working exactly as it does today until #559 retires it.
type TranscriptRecordingActivities struct {
	store TranscriptStore
}

// NewTranscriptRecordingActivities builds the activity set over ts.
func NewTranscriptRecordingActivities(ts TranscriptStore) (*TranscriptRecordingActivities, error) {
	if ts == nil {
		return nil, fmt.Errorf("transcript recording activities: a TranscriptStore is required")
	}
	return &TranscriptRecordingActivities{store: ts}, nil
}

// PersistTranscriptToStoreInput names the Attempt a transcript belongs to
// and carries its raw, uncompressed bytes.
type PersistTranscriptToStoreInput struct {
	Key        work.StageKey
	AttemptNo  int
	Transcript work.Transcript
}

// PersistTranscriptToStore compresses in.Transcript, computes its checksum
// and uncompressed size, and stores the result against in.Key's Attempt.
//
// Compression and the checksum are computed here, on the receiving side,
// deliberately: ADR-0012 forbids adding anything to the stage output payload
// alongside the transcript itself, since the largest one measured
// (internal/work/transcript.go) already sits close to Temporal's payload
// warn threshold.
func (a *TranscriptRecordingActivities) PersistTranscriptToStore(ctx context.Context, in PersistTranscriptToStoreInput) error {
	raw := in.Transcript.Bytes()

	var compressed bytes.Buffer
	gz := gzip.NewWriter(&compressed)
	if _, err := gz.Write(raw); err != nil {
		return fail(ctx, fmt.Sprintf("compressing the transcript for attempt %d of %s", in.AttemptNo, in.Key), err)
	}
	if err := gz.Close(); err != nil {
		return fail(ctx, fmt.Sprintf("closing the compressed transcript for attempt %d of %s", in.AttemptNo, in.Key), err)
	}

	checksum := sha256.Sum256(raw)

	err := a.store.PutTranscript(ctx, store.Transcript{
		Key:                   in.Key,
		AttemptNo:             in.AttemptNo,
		CompressedBytes:       compressed.Bytes(),
		Compression:           gzipCompression,
		UncompressedSizeBytes: int64(len(raw)),
		Checksum:              checksum[:],
	})
	if err != nil {
		return fail(ctx, fmt.Sprintf("storing the transcript for attempt %d of %s", in.AttemptNo, in.Key), err)
	}
	return nil
}
