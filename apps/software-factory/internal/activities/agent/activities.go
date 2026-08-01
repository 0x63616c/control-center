// Package agentactivities contains production agent side-effect boundaries.
package agentactivities

import (
	"context"
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agenttool"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/blobs"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codexresponses"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/sdk/activity"
)

// Turner is the sealed direct model boundary used by a model-turn activity.
type Turner interface {
	Turn(context.Context, codexresponses.TurnRequest, codexresponses.EmitFunc) (codexresponses.TurnResult, error)
}

// Activities owns the production model-side agent activities.
type Activities struct {
	turner        Turner
	conversations agent.ConversationStore
	artifacts     agent.ArtifactStore
	toolsets      map[agent.ToolsetID]agenttool.Set
}

// StreamProgress is content-free provider stream heartbeat metadata.
type StreamProgress struct {
	EventType codexresponses.EventType
	Events    int
}

// NewActivities constructs production model-side agent activities.
func NewActivities(turner Turner, blobStore blobs.Store, toolsets ...agenttool.Set) (*Activities, error) {
	if turner == nil {
		return nil, fmt.Errorf("agent activities need a model turner")
	}
	if blobStore == nil {
		return nil, fmt.Errorf("agent activities need a blob store")
	}
	byID := make(map[agent.ToolsetID]agenttool.Set, len(toolsets))
	for _, toolset := range toolsets {
		if _, exists := byID[toolset.ID()]; exists {
			return nil, fmt.Errorf("agent activities received duplicate toolset %q", toolset.ID())
		}
		byID[toolset.ID()] = toolset
	}
	return &Activities{
		turner:        turner,
		conversations: agent.NewConversationStore(blobStore),
		artifacts:     agent.NewArtifactStore(blobStore),
		toolsets:      byID,
	}, nil
}

// ModelTurn loads one conversation revision, calls the provider, and stores its durable result.
func (activities *Activities) ModelTurn(ctx context.Context, input agent.ModelTurnInput) (agent.ModelTurnResult, error) {
	toolset, ok := activities.toolsets[input.ToolsetID]
	if !ok {
		return agent.ModelTurnResult{}, fmt.Errorf("unknown agent toolset %q", input.ToolsetID)
	}
	items, err := activities.conversations.Items(ctx, input.ConversationRef)
	if err != nil {
		return agent.ModelTurnResult{}, fmt.Errorf("load model conversation: %w", err)
	}
	request, err := modelRequest(input, toolset, items)
	if err != nil {
		return agent.ModelTurnResult{}, err
	}
	events := 0
	providerResult, err := activities.turner.Turn(ctx, request, func(event codexresponses.Event) {
		events++
		activity.RecordHeartbeat(ctx, StreamProgress{EventType: event.Type, Events: events})
	})
	if err != nil {
		return agent.ModelTurnResult{}, fmt.Errorf("run direct model turn: %w", err)
	}
	if providerResult.Outcome != codexresponses.OutcomeFinalText {
		return agent.ModelTurnResult{}, fmt.Errorf("model turn outcome %q is not implemented", providerResult.Outcome)
	}
	identity, err := activities.conversations.Identity(input.ConversationRef)
	if err != nil {
		return agent.ModelTurnResult{}, fmt.Errorf("resolve model conversation identity: %w", err)
	}
	conversationRef, err := activities.conversations.Append(ctx, identity, &input.ConversationRef, []agent.ConversationItem{{
		Kind: agent.ItemAssistantText,
		Text: providerResult.Text,
	}})
	if err != nil {
		return agent.ModelTurnResult{}, fmt.Errorf("store final model conversation: %w", err)
	}
	textRef, err := activities.artifacts.StoreText(ctx, identity, providerResult.Text)
	if err != nil {
		return agent.ModelTurnResult{}, fmt.Errorf("store final model text: %w", err)
	}
	return agent.ModelTurnResult{
		Outcome:         agent.OutcomeFinalText,
		ConversationRef: conversationRef,
		FinalTextRef:    textRef,
		Usage: work.Usage{
			InputTokens:  providerResult.Usage.InputTokens,
			OutputTokens: providerResult.Usage.OutputTokens,
		},
		UsageMeasured: true,
	}, nil
}

func modelRequest(
	input agent.ModelTurnInput,
	toolset agenttool.Set,
	items []agent.ConversationItem,
) (codexresponses.TurnRequest, error) {
	if err := input.Model.Validate(); err != nil {
		return codexresponses.TurnRequest{}, fmt.Errorf("validate model turn: %w", err)
	}
	var instructions string
	providerItems := make([]codexresponses.InputItem, 0, len(items))
	for _, item := range items {
		switch item.Kind {
		case agent.ItemInstructions:
			if instructions != "" {
				return codexresponses.TurnRequest{}, fmt.Errorf("model conversation has multiple instruction blocks")
			}
			instructions = item.Text
		case agent.ItemUserText:
			providerItems = append(providerItems, codexresponses.UserText(item.Text))
		case agent.ItemFunctionCall:
			providerItems = append(providerItems, codexresponses.FunctionCall(codexresponses.ToolCall{
				ID:        item.ID,
				CallID:    item.CallID,
				Name:      item.Name,
				Arguments: item.Arguments,
			}))
		case agent.ItemFunctionOutput:
			providerItems = append(providerItems, codexresponses.FunctionOutput(item.CallID, item.Output))
		default:
			return codexresponses.TurnRequest{}, fmt.Errorf("model conversation has unsupported item kind %q", item.Kind)
		}
	}
	specifications := toolset.Specifications()
	tools := make([]codexresponses.Tool, 0, len(specifications))
	for _, specification := range specifications {
		tools = append(tools, codexresponses.Tool{
			Name:        specification.Name,
			Description: specification.Description,
			Parameters:  specification.Parameters,
		})
	}
	return codexresponses.TurnRequest{
		Model:             input.Model.Name,
		Instructions:      instructions,
		Input:             providerItems,
		Store:             false,
		Tools:             tools,
		ToolChoice:        codexresponses.ToolChoiceAuto,
		ParallelToolCalls: false,
		Reasoning: codexresponses.ReasoningOptions{
			Effort:  codexresponses.ReasoningEffort(input.Model.Effort),
			Summary: codexresponses.ReasoningSummaryAuto,
		},
		TextVerbosity:  codexresponses.TextVerbosityMedium,
		PromptCacheKey: input.PromptCacheKey,
		Include:        []string{"reasoning.encrypted_content"},
	}, nil
}
