package agentactivities

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agenttool"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/blobs"
	"go.temporal.io/sdk/temporal"
)

// ToolActivities owns sandbox-side generic tool dispatch and retry records.
type ToolActivities struct {
	blobs         blobs.Store
	artifacts     agent.ArtifactStore
	conversations agent.ConversationStore
	toolsets      map[agent.ToolsetID]agenttool.Set
}

// NewToolActivities constructs the sandbox-side generic tool activity.
func NewToolActivities(blobStore blobs.Store, toolsets ...agenttool.Set) (*ToolActivities, error) {
	if blobStore == nil {
		return nil, fmt.Errorf("agent tool activities need a blob store")
	}
	byID := make(map[agent.ToolsetID]agenttool.Set, len(toolsets))
	for _, toolset := range toolsets {
		if _, exists := byID[toolset.ID()]; exists {
			return nil, fmt.Errorf("agent tool activities received duplicate toolset %q", toolset.ID())
		}
		byID[toolset.ID()] = toolset
	}
	return &ToolActivities{
		blobs: blobStore, artifacts: agent.NewArtifactStore(blobStore),
		conversations: agent.NewConversationStore(blobStore), toolsets: byID,
	}, nil
}

// Tool executes one typed tool call exactly once and appends its provider output.
func (activities *ToolActivities) Tool(ctx context.Context, input agent.ToolInput) (agent.ToolOutput, error) {
	toolset, ok := activities.toolsets[input.ToolsetID]
	if !ok {
		return agent.ToolOutput{}, invalidInput("unknown agent toolset %q", input.ToolsetID)
	}
	identity, err := activities.conversations.Identity(input.ConversationRef)
	if err != nil {
		return agent.ToolOutput{}, invalidInput("resolve tool conversation identity: %v", err)
	}
	startedKey, completedKey, err := operationKeys(identity, input.ConversationRef.Revision, input.Call.CallID)
	if err != nil {
		return agent.ToolOutput{}, invalidInput("name tool operation: %v", err)
	}
	if encoded, err := activities.blobs.Get(ctx, completedKey); err == nil {
		var recorded agent.ToolOutput
		if err := json.Unmarshal(encoded, &recorded); err != nil {
			return agent.ToolOutput{}, transientFailure("decode completed tool operation", err)
		}
		return recorded, nil
	} else if !errors.Is(err, blobs.ErrNotFound) {
		return agent.ToolOutput{}, transientFailure("load completed tool operation", err)
	}
	arguments, err := activities.artifacts.LoadArguments(ctx, input.Call.ArgumentsRef)
	if err != nil {
		return agent.ToolOutput{}, transientFailure("load tool arguments", err)
	}
	if _, err := activities.blobs.Get(ctx, startedKey); err == nil {
		return agent.ToolOutput{}, temporal.NewNonRetryableApplicationError(
			"tool execution was interrupted after it started", "AmbiguousToolExecution", nil,
		)
	} else if !errors.Is(err, blobs.ErrNotFound) {
		return agent.ToolOutput{}, transientFailure("load started tool operation", err)
	}
	if err := activities.blobs.Put(ctx, startedKey, []byte(input.Call.CallID)); err != nil {
		return agent.ToolOutput{}, transientFailure("record started tool operation", err)
	}
	result, err := toolset.Execute(ctx, input.Call.Name, arguments)
	if err != nil {
		return agent.ToolOutput{}, err
	}
	conversationRef, err := activities.conversations.Append(ctx, identity, &input.ConversationRef, []agent.ConversationItem{{
		Kind: agent.ItemFunctionOutput, CallID: input.Call.CallID, Output: result.Content,
	}})
	if err != nil {
		return agent.ToolOutput{}, transientFailure("store tool output conversation", err)
	}
	output := agent.ToolOutput{CallID: input.Call.CallID, ConversationRef: conversationRef, IsError: result.IsError}
	encoded, err := json.Marshal(output)
	if err != nil {
		return agent.ToolOutput{}, fmt.Errorf("encode completed tool operation: %w", err)
	}
	if err := activities.blobs.Put(ctx, completedKey, encoded); err != nil {
		return agent.ToolOutput{}, transientFailure("record completed tool operation", err)
	}
	return output, nil
}

func operationKeys(identity string, revision int, callID string) (blobs.Key, blobs.Key, error) {
	if callID == "" {
		return blobs.Key{}, blobs.Key{}, fmt.Errorf("call id is blank")
	}
	digestBytes := sha256.Sum256([]byte(callID))
	operation := fmt.Sprintf("%s/operations/%d/%s", identity, revision, hex.EncodeToString(digestBytes[:]))
	started, err := blobs.NewKey(blobs.BucketConversations, operation+"/started")
	if err != nil {
		return blobs.Key{}, blobs.Key{}, err
	}
	completed, err := blobs.NewKey(blobs.BucketConversations, operation+"/completed")
	return started, completed, err
}
