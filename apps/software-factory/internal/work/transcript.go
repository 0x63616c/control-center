package work

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
