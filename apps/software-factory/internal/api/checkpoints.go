package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/checkpoint"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// AgentCheckpointStore is the only persistence authority exposed to the Run Worker route.
type AgentCheckpointStore interface {
	CheckpointAgentAttempt(context.Context, store.AgentCheckpointInput) (store.AgentAttempt, error)
}

type agentCheckpointInput struct {
	RunID       string `path:"runID" format:"uuid" doc:"The owning Run identity."`
	StepOrdinal int    `path:"stepOrdinal" minimum:"1" doc:"The active agent-backed Step ordinal."`
	AttemptNo   int    `path:"attemptNo" minimum:"1" doc:"The workflow-authorized Agent Attempt number."`
	Capability  string `header:"X-Software-Factory-Checkpoint-Capability" doc:"The capability minted for this exact active Agent Attempt."`
	Body        checkpoint.Attempt
}

func checkpointOperation(operation *huma.Operation) {
	operation.Summary = "Checkpoint an active Agent Attempt"
	operation.Description = "Stores running provider identity or terminal execution evidence using a capability scoped to the exact Run, Step, and Agent Attempt."
	operation.Security = []map[string][]string{{"agentCheckpointCapability": {}}}
}

func (service *Service) checkpointAgentAttempt(ctx context.Context, input *agentCheckpointInput) (*struct{}, error) {
	if strings.TrimSpace(input.Capability) == "" {
		return nil, clientError(http.StatusUnauthorized, "checkpoint_unauthorized", "checkpoint capability is required")
	}
	if service.checkpoints == nil {
		return nil, clientError(http.StatusServiceUnavailable, "checkpoint_unavailable", "checkpoint store is not configured")
	}

	checkpointInput := store.AgentCheckpointInput{
		ID: store.TargetAttemptID{
			RunID: input.RunID, StepOrdinal: input.StepOrdinal, AttemptNo: input.AttemptNo,
		},
		Capability:  input.Capability,
		ThreadID:    input.Body.ProviderThreadID,
		State:       input.Body.State,
		FailureKind: input.Body.FailureKind,
		UsageState:  input.Body.UsageState,
		Usage: work.Usage{
			InputTokens: input.Body.Usage.InputTokens, CachedInputTokens: input.Body.Usage.CachedInputTokens,
			OutputTokens: input.Body.Usage.OutputTokens, ReasoningTokens: input.Body.Usage.ReasoningTokens,
		},
		EndedAt:    checkpointEndedAt(input.Body.EndedAt),
		Result:     input.Body.Result,
		Transcript: checkpointTranscript(input.Body.Transcript),
	}
	if err := checkpointInput.Validate(); err != nil {
		return nil, clientError(http.StatusUnprocessableEntity, "invalid_checkpoint", "checkpoint evidence is invalid")
	}
	if _, err := service.checkpoints.CheckpointAgentAttempt(ctx, checkpointInput); err != nil {
		return nil, checkpointStoreError(err)
	}
	return &struct{}{}, nil
}

func checkpointEndedAt(endedAt *time.Time) time.Time {
	if endedAt == nil {
		return time.Time{}
	}
	return endedAt.UTC()
}

func checkpointTranscript(transcript *checkpoint.Transcript) *store.TargetTranscript {
	if transcript == nil {
		return nil
	}
	return &store.TargetTranscript{
		CompressedBytes: transcript.CompressedBytes, Compression: transcript.Compression,
		UncompressedSizeBytes: transcript.UncompressedSizeBytes, Checksum: transcript.Checksum,
	}
}

func checkpointStoreError(err error) error {
	switch {
	case errors.Is(err, store.ErrRunOwnership), errors.Is(err, store.ErrNotFound):
		return clientError(http.StatusUnauthorized, "checkpoint_unauthorized", "checkpoint capability does not authorize this attempt")
	case errors.Is(err, work.ErrPermanent):
		return clientError(http.StatusConflict, "checkpoint_conflict", "checkpoint conflicts with durable attempt state")
	default:
		return clientError(http.StatusServiceUnavailable, "checkpoint_unavailable", "checkpoint persistence is temporarily unavailable")
	}
}
