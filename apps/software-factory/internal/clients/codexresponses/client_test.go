package codexresponses

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

type staticCredentialSource struct {
	credential Credential
}

func (s staticCredentialSource) Credential(context.Context) (Credential, error) {
	return s.credential, nil
}

func TestTurnReturnsACompletedTextResponse(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer access-token" {
			t.Errorf("Authorization = %q, want redacted test credential", got)
		}
		if got := r.Header.Get("chatgpt-account-id"); got != "account-123" {
			t.Errorf("chatgpt-account-id = %q, want account-123", got)
		}

		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decoding request: %v", err)
			return
		}
		if request["model"] != "gpt-test" || request["instructions"] != "Answer briefly." || request["stream"] != true {
			t.Errorf("request = %#v", request)
		}

		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_123\"}}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"id\":\"msg_123\",\"role\":\"assistant\",\"content\":[]}}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"hello \"}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"world\"}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"message\",\"id\":\"msg_123\",\"role\":\"assistant\",\"phase\":\"final_answer\",\"content\":[{\"type\":\"output_text\",\"text\":\"hello world\"}]}}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_123\",\"status\":\"completed\",\"usage\":{\"input_tokens\":12,\"output_tokens\":3,\"total_tokens\":15}}}\n\n")
	}))
	defer server.Close()

	client, err := New(
		&http.Client{Timeout: 2 * time.Second},
		server.URL,
		staticCredentialSource{credential: Credential{
			AccessToken: work.NewCredential("access-token"),
			AccountID:   "account-123",
		}},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	if err != nil {
		t.Fatalf("constructing client: %v", err)
	}

	result, err := client.Turn(context.Background(), TurnRequest{
		Model:         "gpt-test",
		Instructions:  "Answer briefly.",
		Input:         []InputItem{UserText("Say hello.")},
		Store:         false,
		ToolChoice:    ToolChoiceNone,
		TextVerbosity: TextVerbosityLow,
	}, nil)
	if err != nil {
		t.Fatalf("running turn: %v", err)
	}
	if result.Outcome != OutcomeFinalText || result.Text != "hello world" || result.ResponseID != "resp_123" {
		t.Fatalf("result = %#v", result)
	}
	if result.Usage.InputTokens != 12 || result.Usage.OutputTokens != 3 || result.Usage.TotalTokens != 15 {
		t.Fatalf("usage = %#v", result.Usage)
	}
}

func TestTurnReturnsACompleteToolCallFromStreamedArguments(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Tools             []Tool           `json:"tools"`
			ToolChoice        ToolChoice       `json:"tool_choice"`
			ParallelToolCalls bool             `json:"parallel_tool_calls"`
			Reasoning         ReasoningOptions `json:"reasoning"`
			Text              struct {
				Verbosity TextVerbosity `json:"verbosity"`
			} `json:"text"`
			PromptCacheKey string `json:"prompt_cache_key"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decoding request: %v", err)
			return
		}
		if len(request.Tools) != 1 || request.Tools[0].Name != "lookup_weather" || request.ToolChoice != ToolChoiceAuto {
			t.Errorf("tool request = %#v", request)
		}
		if request.ParallelToolCalls || request.Reasoning.Effort != ReasoningEffortMedium ||
			request.Reasoning.Summary != ReasoningSummaryAuto || request.Text.Verbosity != TextVerbosityMedium ||
			request.PromptCacheKey != "workflow-123" {
			t.Errorf("request options = %#v", request)
		}

		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_tool\"}}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"id\":\"fc_123\",\"call_id\":\"call_123\",\"name\":\"lookup_weather\",\"arguments\":\"\"}}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":0,\"delta\":\"{\\\"city\\\":\"}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":0,\"delta\":\"\\\"London\\\"}\"}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.function_call_arguments.done\",\"output_index\":0,\"arguments\":\"{\\\"city\\\":\\\"London\\\"}\"}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"id\":\"fc_123\",\"call_id\":\"call_123\",\"name\":\"lookup_weather\",\"arguments\":\"{\\\"city\\\":\\\"London\\\"}\"}}\n\n")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_tool\",\"status\":\"completed\",\"usage\":{\"input_tokens\":20,\"output_tokens\":8,\"total_tokens\":28}}}\n\n")
	}))
	defer server.Close()

	client, err := New(
		&http.Client{Timeout: 2 * time.Second},
		server.URL,
		staticCredentialSource{credential: Credential{
			AccessToken: work.NewCredential("access-token"),
			AccountID:   "account-123",
		}},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	if err != nil {
		t.Fatalf("constructing client: %v", err)
	}

	result, err := client.Turn(context.Background(), TurnRequest{
		Model:        "gpt-test",
		Instructions: "Use the weather tool.",
		Input:        []InputItem{UserText("Weather in London?")},
		Store:        true,
		Tools: []Tool{{
			Name:        "lookup_weather",
			Description: "Look up deterministic prototype weather.",
			Parameters:  json.RawMessage(`{"type":"object","properties":{"city":{"type":"string"}},"required":["city"],"additionalProperties":false}`),
		}},
		ToolChoice:        ToolChoiceAuto,
		ParallelToolCalls: false,
		Reasoning: ReasoningOptions{
			Effort:  ReasoningEffortMedium,
			Summary: ReasoningSummaryAuto,
		},
		TextVerbosity:  TextVerbosityMedium,
		PromptCacheKey: "workflow-123",
	}, nil)
	if err != nil {
		t.Fatalf("running turn: %v", err)
	}
	if result.Outcome != OutcomeToolCalls || result.ResponseID != "resp_tool" || len(result.ToolCalls) != 1 {
		t.Fatalf("result = %#v", result)
	}
	call := result.ToolCalls[0]
	if call.ID != "fc_123" || call.CallID != "call_123" || call.Name != "lookup_weather" || string(call.Arguments) != `{"city":"London"}` {
		t.Fatalf("tool call = %#v", call)
	}
}
