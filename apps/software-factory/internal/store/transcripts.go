package store

import (
	"context"
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store/storedb"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// TranscriptWriter stores one Attempt's compressed transcript. PersistTranscript
// is this method's one caller (ADR-0012: the existing durable-write chokepoint,
// pointed at Postgres instead of NFS).
type TranscriptWriter interface {
	PutTranscript(ctx context.Context, t Transcript) error
}

// TranscriptReader reads back one Attempt's transcript, for download through
// the API.
type TranscriptReader interface {
	Transcript(ctx context.Context, key work.StageKey, attemptNo int) (Transcript, error)
}

// PutTranscript stores t. A transcript belongs to exactly one Attempt, which
// must already have been recorded — the table's foreign key enforces it.
func (s *Store) PutTranscript(ctx context.Context, t Transcript) error {
	runID, err := pgUUID(t.Key.RunID)
	if err != nil {
		return fmt.Errorf("storing transcript for attempt %d of step %s: %w", t.AttemptNo, t.Key, err)
	}
	err = s.q.PutTranscript(ctx, storedb.PutTranscriptParams{
		RunID:                 runID,
		Stage:                 string(t.Key.Stage),
		Turn:                  int32(t.Key.Turn),
		AttemptNo:             int32(t.AttemptNo),
		CompressedBytes:       t.CompressedBytes,
		Compression:           t.Compression,
		UncompressedSizeBytes: t.UncompressedSizeBytes,
		Checksum:              t.Checksum,
	})
	if err != nil {
		return fmt.Errorf("storing transcript for attempt %d of step %s: %w", t.AttemptNo, t.Key, wrapQueryErr(err))
	}
	return nil
}

// Transcript reads back the transcript for attemptNo of the Step key
// identifies.
func (s *Store) Transcript(ctx context.Context, key work.StageKey, attemptNo int) (Transcript, error) {
	runID, err := pgUUID(key.RunID)
	if err != nil {
		return Transcript{}, fmt.Errorf("reading transcript for attempt %d of step %s: %w", attemptNo, key, err)
	}
	row, err := s.q.Transcript(ctx, storedb.TranscriptParams{
		RunID:     runID,
		Stage:     string(key.Stage),
		Turn:      int32(key.Turn),
		AttemptNo: int32(attemptNo),
	})
	if err != nil {
		return Transcript{}, fmt.Errorf("reading transcript for attempt %d of step %s: %w", attemptNo, key, wrapQueryErr(err))
	}
	return Transcript{
		Key:                   key,
		AttemptNo:             attemptNo,
		CompressedBytes:       row.CompressedBytes,
		Compression:           row.Compression,
		UncompressedSizeBytes: row.UncompressedSizeBytes,
		Checksum:              row.Checksum,
	}, nil
}

var (
	_ TranscriptWriter = (*Store)(nil)
	_ TranscriptReader = (*Store)(nil)
)
