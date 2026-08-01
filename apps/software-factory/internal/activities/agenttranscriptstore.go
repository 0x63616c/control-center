package activities

import (
	"context"
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/blobs"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// AgentTranscriptRecordingActivities persists reference-backed agent transcripts.
type AgentTranscriptRecordingActivities struct {
	recording   *TranscriptRecordingActivities
	transcripts agent.TranscriptStore
}

// PersistAgentTranscriptInput identifies an already-recorded Attempt and its transcript.
type PersistAgentTranscriptInput struct {
	Key           work.StageKey
	AttemptNo     int
	TranscriptRef agent.TranscriptRef
}

// NewAgentTranscriptRecordingActivities builds transcript persistence from blob ref to database.
func NewAgentTranscriptRecordingActivities(
	transcriptStore TranscriptStore,
	blobStore blobs.Store,
) (*AgentTranscriptRecordingActivities, error) {
	recording, err := NewTranscriptRecordingActivities(transcriptStore)
	if err != nil {
		return nil, fmt.Errorf("build agent transcript recording activities: %w", err)
	}
	if blobStore == nil {
		return nil, fmt.Errorf("agent transcript recording activities: a blob store is required")
	}
	return &AgentTranscriptRecordingActivities{
		recording: recording, transcripts: agent.NewTranscriptStore(blobStore),
	}, nil
}

// PersistAgentTranscript loads JSONL from the immutable ref and stores it against the Attempt.
func (activities *AgentTranscriptRecordingActivities) PersistAgentTranscript(
	ctx context.Context,
	input PersistAgentTranscriptInput,
) error {
	raw, err := activities.transcripts.JSONL(ctx, input.TranscriptRef)
	if err != nil {
		return fail(ctx, fmt.Sprintf("loading the agent transcript for attempt %d of %s", input.AttemptNo, input.Key), err)
	}
	return activities.recording.PersistTranscriptToStore(ctx, PersistTranscriptToStoreInput{
		Key: input.Key, AttemptNo: input.AttemptNo, Transcript: work.Transcript(raw),
	})
}
