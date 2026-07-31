package activities

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"io"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store/storefake"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

func mustNewTranscriptRecording(t *testing.T, ts TranscriptStore) *TranscriptRecordingActivities {
	t.Helper()
	a, err := NewTranscriptRecordingActivities(ts)
	if err != nil {
		t.Fatalf("NewTranscriptRecordingActivities: %v", err)
	}
	return a
}

func TestNewTranscriptRecordingActivitiesRejectsANilStore(t *testing.T) {
	t.Parallel()

	if _, err := NewTranscriptRecordingActivities(nil); err == nil {
		t.Fatal("a nil TranscriptStore must be rejected at construction, not the first call")
	}
}

// decompress reverses PersistTranscriptToStore's gzip compression, the way a
// future download endpoint would, so tests can assert on the original bytes.
func decompress(t *testing.T, compressed []byte) []byte {
	t.Helper()
	r, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		t.Fatalf("gzip.NewReader: %v", err)
	}
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("reading decompressed transcript: %v", err)
	}
	if err := r.Close(); err != nil {
		t.Fatalf("closing gzip reader: %v", err)
	}
	return out
}

// TestPersistTranscriptToStoreRoundTripsByteIdentical proves a persisted
// transcript is stored compressed and reads back byte-identical to what the
// stage produced, with its checksum and uncompressed size recorded and
// matching (#550 acceptance criteria 3 and 4).
func TestPersistTranscriptToStoreRoundTripsByteIdentical(t *testing.T) {
	t.Parallel()

	fake := storefake.New()
	a := mustNewTranscriptRecording(t, fake)
	ctx := context.Background()
	key := work.StageKey{Ticket: 1, RunID: "019fb100-0000-7000-8000-000000000001", Stage: work.StageImplement, Turn: 1}
	original := work.Transcript(`{"type":"turn.started"}` + "\n" + `{"type":"turn.completed"}` + "\n")

	if err := a.PersistTranscriptToStore(ctx, PersistTranscriptToStoreInput{Key: key, AttemptNo: 1, Transcript: original}); err != nil {
		t.Fatalf("PersistTranscriptToStore: %v", err)
	}

	stored, err := fake.Transcript(ctx, key, 1)
	if err != nil {
		t.Fatalf("Transcript: %v", err)
	}
	if stored.Compression != gzipCompression {
		t.Fatalf("Compression = %q, want %q", stored.Compression, gzipCompression)
	}

	got := decompress(t, stored.CompressedBytes)
	if !bytes.Equal(got, original.Bytes()) {
		t.Fatalf("round-tripped transcript = %q, want %q", got, original.Bytes())
	}

	wantChecksum := sha256.Sum256(original.Bytes())
	if !bytes.Equal(stored.Checksum, wantChecksum[:]) {
		t.Fatalf("Checksum = %x, want %x", stored.Checksum, wantChecksum)
	}
	if stored.UncompressedSizeBytes != int64(len(original.Bytes())) {
		t.Fatalf("UncompressedSizeBytes = %d, want %d", stored.UncompressedSizeBytes, len(original.Bytes()))
	}
}

// TestPersistTranscriptToStoreRetriedForTheSameAttemptDoesNotDuplicate
// proves #550 acceptance criterion 5: persisting the same transcript twice —
// an activity retry — does not create a second row.
func TestPersistTranscriptToStoreRetriedForTheSameAttemptDoesNotDuplicate(t *testing.T) {
	t.Parallel()

	fake := storefake.New()
	a := mustNewTranscriptRecording(t, fake)
	ctx := context.Background()
	key := work.StageKey{Ticket: 1, RunID: "019fb100-0000-7000-8000-000000000002", Stage: work.StagePlan, Turn: 1}
	in := PersistTranscriptToStoreInput{Key: key, AttemptNo: 1, Transcript: work.Transcript("x")}

	if err := a.PersistTranscriptToStore(ctx, in); err != nil {
		t.Fatalf("first PersistTranscriptToStore: %v", err)
	}
	if err := a.PersistTranscriptToStore(ctx, in); err != nil {
		t.Fatalf("retried PersistTranscriptToStore: %v", err)
	}

	stored, err := fake.Transcript(ctx, key, 1)
	if err != nil {
		t.Fatalf("Transcript: %v", err)
	}
	got := decompress(t, stored.CompressedBytes)
	if string(got) != "x" {
		t.Fatalf("stored transcript = %q, want %q — a retry must not corrupt or duplicate it", got, "x")
	}
}
