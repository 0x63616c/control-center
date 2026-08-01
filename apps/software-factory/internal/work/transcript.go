package work

const (
	// MaxTargetTranscriptUncompressedBytes keeps one Agent Attempt below the
	// Temporal payload warning boundary while retaining more than the largest
	// measured production transcript (292 KiB).
	MaxTargetTranscriptUncompressedBytes = 320 << 10
	// MaxTargetTranscriptCompressedBytes is the Store/API defense in depth for
	// the compressed row carried over the checkpoint protocol.
	MaxTargetTranscriptCompressedBytes = 384 << 10
)

// Transcript is one stage attempt's whole raw event stream, as JSONL.
//
// It is retained in the legacy stage activity result wire type so Temporal can
// replay executions started before AgentWorkflow. New executions persist a
// blob-backed agent.TranscriptRef instead of carrying these bytes in history.
//
// A named byte slice rather than a plain []byte keeps that historical wire
// contract explicit.
type Transcript []byte

// Bytes returns the transcript's raw content.
func (t Transcript) Bytes() []byte { return []byte(t) }
