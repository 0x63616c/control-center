package activities

import (
	"bytes"
	"crypto/sha256"
	"strings"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/blobs"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store/storefake"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

func TestPersistAgentTranscriptLoadsJSONLByReference(t *testing.T) {
	t.Parallel()

	blobStore := blobs.NewMemStore()
	transcripts := agent.NewTranscriptStore(blobStore)
	prepared, err := transcripts.Append(t.Context(), "agent/run-7/plan/1", nil, agent.TranscriptEvent{Type: agent.EventWorkflowPrepared})
	if err != nil {
		t.Fatalf("Append(prepared) error = %v", err)
	}
	finalized, err := transcripts.Append(t.Context(), "agent/run-7/plan/1", &prepared, agent.TranscriptEvent{Type: agent.EventFinalOutputDecoded})
	if err != nil {
		t.Fatalf("Append(finalized) error = %v", err)
	}
	database := storefake.New()
	activities, err := NewAgentTranscriptRecordingActivities(database, blobStore)
	if err != nil {
		t.Fatalf("NewAgentTranscriptRecordingActivities() error = %v", err)
	}
	key := work.StageKey{Ticket: 7, RunID: "run-7", Stage: work.StagePlan, Turn: 1}
	if err := activities.PersistAgentTranscript(t.Context(), PersistAgentTranscriptInput{
		Key: key, AttemptNo: 1, TranscriptRef: finalized,
	}); err != nil {
		t.Fatalf("PersistAgentTranscript() error = %v", err)
	}
	stored, err := database.Transcript(t.Context(), key, 1)
	if err != nil {
		t.Fatalf("Transcript() error = %v", err)
	}
	raw := decompress(t, stored.CompressedBytes)
	if !bytes.Equal(stored.Checksum, checksum(raw)) || !strings.Contains(string(raw), `"type":"workflow_prepared"`) ||
		!strings.Contains(string(raw), `"type":"final_output_decoded"`) {
		t.Fatalf("stored agent transcript = %q checksum=%x", raw, stored.Checksum)
	}
}

func checksum(value []byte) []byte {
	digest := sha256.Sum256(value)
	return digest[:]
}
