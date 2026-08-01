// Package checkpoint defines the narrow Run Worker checkpoint HTTP protocol.
package checkpoint

import (
	"encoding/json"
	"net/url"
	"strconv"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// AttemptPath renders one exact Agent Attempt checkpoint path.
func AttemptPath(runID string, stepOrdinal, attemptNo int) string {
	return "/v1/run-worker/runs/" + url.PathEscape(runID) + "/steps/" + strconv.Itoa(stepOrdinal) + "/attempts/" + strconv.Itoa(attemptNo) + "/checkpoint"
}

const (
	// CapabilityHeader carries one active Agent Attempt's checkpoint capability.
	CapabilityHeader = "X-Software-Factory-Checkpoint-Capability"
	// Path is the exact-attempt checkpoint route registered by the factory API.
	Path = "/v1/run-worker/runs/{runID}/steps/{stepOrdinal}/attempts/{attemptNo}/checkpoint"
	// ServeMuxPattern is the only method and path mounted outside the legacy API authentication middleware.
	ServeMuxPattern = "PUT " + Path
)

// Attempt is running progress or terminal evidence for one active Agent Attempt.
type Attempt struct {
	ProviderThreadID string                 `json:"providerThreadId,omitempty" doc:"The provider thread identity exposed by the active execution."`
	State            work.AgentAttemptState `json:"state" enum:"running,succeeded,failed" doc:"The execution state this checkpoint proves."`
	FailureKind      work.RunFailureKind    `json:"failureKind,omitempty" doc:"The classified terminal failure, when state is failed."`
	UsageState       work.UsageState        `json:"usageState" enum:"unknown,measured" doc:"Whether provider usage is available."`
	Usage            Usage                  `json:"usage" doc:"Provider-reported token usage; all fields are zero while usage is unknown."`
	EndedAt          *time.Time             `json:"endedAt,omitempty" doc:"RFC3339 UTC terminal time; absent while running."`
	Result           json.RawMessage        `json:"result,omitempty" doc:"The terminal provider envelope; absent while running."`
	Transcript       *Transcript            `json:"transcript,omitempty" doc:"Durable partial or terminal transcript material."`
}

// Usage is the provider's four token counters.
type Usage struct {
	InputTokens       int64 `json:"inputTokens" minimum:"0" doc:"Whole input tokens, including cached input."`
	CachedInputTokens int64 `json:"cachedInputTokens" minimum:"0" doc:"Input tokens served from cache."`
	OutputTokens      int64 `json:"outputTokens" minimum:"0" doc:"Whole output tokens, including reasoning."`
	ReasoningTokens   int64 `json:"reasoningTokens" minimum:"0" doc:"Output tokens spent reasoning."`
}

// Transcript is compressed transcript material and its integrity metadata.
type Transcript struct {
	CompressedBytes       []byte `json:"compressedBytes" doc:"Compressed transcript bytes, base64 encoded on the wire."`
	Compression           string `json:"compression" minLength:"1" doc:"The transcript compression codec."`
	UncompressedSizeBytes int64  `json:"uncompressedSizeBytes" minimum:"0" doc:"Transcript size before compression."`
	Checksum              []byte `json:"checksum" doc:"Transcript checksum, base64 encoded on the wire."`
}
