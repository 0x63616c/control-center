package agentactivities

import (
	"context"
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/blobs"
)

// PromptActivities owns stage prompt preparation and final result decoding.
type PromptActivities struct {
	prompts   PromptRenderer
	artifacts agent.ArtifactStore
}

// NewPromptActivities constructs the prompt activities over the shared blob store.
func NewPromptActivities(renderer PromptRenderer, blobStore blobs.Store) (*PromptActivities, error) {
	if renderer == nil {
		return nil, fmt.Errorf("agent prompt activities need a prompt renderer")
	}
	if blobStore == nil {
		return nil, fmt.Errorf("agent prompt activities need a blob store")
	}
	return &PromptActivities{prompts: renderer, artifacts: agent.NewArtifactStore(blobStore)}, nil
}

// Finalize loads terminal model text and decodes the stage's existing result envelope.
func (activities *PromptActivities) Finalize(ctx context.Context, input FinalizeInput) (FinalizeOutput, error) {
	text, err := activities.artifacts.LoadText(ctx, input.TextRef)
	if err != nil {
		return FinalizeOutput{}, transientFailure("load final agent text", err)
	}
	result, err := activities.prompts.Decode(input.Stage, []byte(text))
	if err != nil {
		return FinalizeOutput{}, invalidProviderOutcome("decode final %s output: %v", input.Stage, err)
	}
	return FinalizeOutput{Result: result}, nil
}
