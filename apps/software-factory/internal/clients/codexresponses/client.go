package codexresponses

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
)

const maxSSEEventBytes = 4 << 20

// Client calls the unsupported subscription-backed Codex Responses endpoint.
type Client struct {
	httpClient *http.Client
	endpoint   string
	auth       CredentialSource
	log        *slog.Logger
}

// New constructs a direct Codex Responses client.
func New(httpClient *http.Client, endpoint string, auth CredentialSource, logger *slog.Logger) (*Client, error) {
	switch {
	case httpClient == nil:
		return nil, fmt.Errorf("a Codex Responses client needs an HTTP client")
	case httpClient.Timeout <= 0:
		return nil, fmt.Errorf("a Codex Responses client needs a bounded HTTP timeout")
	case endpoint == "":
		return nil, fmt.Errorf("a Codex Responses client needs an endpoint")
	case auth == nil:
		return nil, fmt.Errorf("a Codex Responses client needs a credential source")
	case logger == nil:
		return nil, fmt.Errorf("a Codex Responses client needs a logger")
	}
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return nil, fmt.Errorf("parsing the Codex Responses endpoint: %w", err)
	}
	if parsed.Scheme != "https" && (parsed.Scheme != "http" || !loopback(parsed.Host)) {
		return nil, fmt.Errorf("the Codex Responses endpoint must be HTTPS, or loopback HTTP for tests")
	}
	return &Client{httpClient: httpClient, endpoint: endpoint, auth: auth, log: logger}, nil
}

func loopback(host string) bool {
	name, _, err := net.SplitHostPort(host)
	if err != nil {
		name = host
	}
	if name == "localhost" {
		return true
	}
	ip := net.ParseIP(name)
	return ip != nil && ip.IsLoopback()
}

// Turn runs one streamed model turn and returns only its durable result.
func (c *Client) Turn(ctx context.Context, request TurnRequest, emit EmitFunc) (TurnResult, error) {
	credential, err := c.auth.Credential(ctx)
	if err != nil {
		return TurnResult{}, fmt.Errorf("loading the Codex Responses credential: %w", err)
	}
	if credential.AccessToken.Reveal() == "" || credential.AccountID == "" {
		return TurnResult{}, fmt.Errorf("the Codex Responses credential is incomplete")
	}

	body, err := encodeRequest(request)
	if err != nil {
		return TurnResult{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return TurnResult{}, fmt.Errorf("building the Codex Responses request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+credential.AccessToken.Reveal())
	req.Header.Set("chatgpt-account-id", credential.AccountID)
	req.Header.Set("originator", "world-wide-webb-poc")
	req.Header.Set("OpenAI-Beta", "responses=experimental")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return TurnResult{}, fmt.Errorf("calling the Codex Responses endpoint: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		return TurnResult{}, fmt.Errorf("the Codex Responses endpoint answered HTTP %d", resp.StatusCode)
	}

	result, err := parseStream(resp.Body, emit)
	if err != nil {
		return TurnResult{}, fmt.Errorf("reading the Codex Responses stream: %w", err)
	}
	c.log.DebugContext(ctx, "Codex Responses turn completed",
		"response_id", result.ResponseID,
		"outcome", result.Outcome,
		"input_tokens", result.Usage.InputTokens,
		"output_tokens", result.Usage.OutputTokens,
	)
	return result, nil
}

type wireRequest struct {
	Model             string          `json:"model"`
	Store             bool            `json:"store"`
	Stream            bool            `json:"stream"`
	Instructions      string          `json:"instructions"`
	Input             []wireInputItem `json:"input"`
	ToolChoice        ToolChoice      `json:"tool_choice"`
	ParallelToolCalls bool            `json:"parallel_tool_calls"`
	Text              wireText        `json:"text"`
}

type wireInputItem struct {
	Role    string             `json:"role"`
	Content []wireInputContent `json:"content"`
}

type wireInputContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type wireText struct {
	Verbosity TextVerbosity `json:"verbosity"`
}

func encodeRequest(request TurnRequest) ([]byte, error) {
	if request.Model == "" || request.Instructions == "" || len(request.Input) == 0 {
		return nil, fmt.Errorf("a Codex Responses turn needs a model, instructions, and input")
	}
	input := make([]wireInputItem, 0, len(request.Input))
	for _, item := range request.Input {
		if item.Type != InputUserText || item.Text == "" {
			return nil, fmt.Errorf("the Codex Responses turn contains an unsupported or blank input item")
		}
		input = append(input, wireInputItem{
			Role:    "user",
			Content: []wireInputContent{{Type: "input_text", Text: item.Text}},
		})
	}
	encoded, err := json.Marshal(wireRequest{
		Model:             request.Model,
		Store:             request.Store,
		Stream:            true,
		Instructions:      request.Instructions,
		Input:             input,
		ToolChoice:        request.ToolChoice,
		ParallelToolCalls: request.ParallelToolCalls,
		Text:              wireText{Verbosity: request.TextVerbosity},
	})
	if err != nil {
		return nil, fmt.Errorf("encoding the Codex Responses request: %w", err)
	}
	return encoded, nil
}

type wireEvent struct {
	Type     string       `json:"type"`
	Delta    string       `json:"delta"`
	Item     wireItem     `json:"item"`
	Response wireResponse `json:"response"`
}

type wireItem struct {
	Type    string        `json:"type"`
	Content []wireContent `json:"content"`
}

type wireContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type wireResponse struct {
	ID     string    `json:"id"`
	Status string    `json:"status"`
	Usage  wireUsage `json:"usage"`
}

type wireUsage struct {
	InputTokens  int64 `json:"input_tokens"`
	OutputTokens int64 `json:"output_tokens"`
	TotalTokens  int64 `json:"total_tokens"`
}

func parseStream(reader io.Reader, emit EmitFunc) (TurnResult, error) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64<<10), maxSSEEventBytes)
	var data []string
	var result TurnResult
	terminal := false
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if err := consumeEvent(data, &result, emit, &terminal); err != nil {
				return TurnResult{}, err
			}
			data = data[:0]
			continue
		}
		if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if err := scanner.Err(); err != nil {
		return TurnResult{}, fmt.Errorf("scanning SSE events: %w", err)
	}
	if err := consumeEvent(data, &result, emit, &terminal); err != nil {
		return TurnResult{}, err
	}
	if !terminal {
		return TurnResult{}, fmt.Errorf("the stream ended before a terminal response event")
	}
	if result.Outcome == "" {
		return TurnResult{}, fmt.Errorf("the completed response contained neither final text nor tool calls")
	}
	return result, nil
}

func consumeEvent(data []string, result *TurnResult, emit EmitFunc, terminal *bool) error {
	if len(data) == 0 {
		return nil
	}
	payload := strings.Join(data, "\n")
	if payload == "[DONE]" {
		return nil
	}
	var event wireEvent
	if err := json.Unmarshal([]byte(payload), &event); err != nil {
		return fmt.Errorf("decoding SSE event: %w", err)
	}
	switch event.Type {
	case "response.created":
		result.ResponseID = event.Response.ID
	case "response.output_text.delta":
		result.Text += event.Delta
		if emit != nil {
			emit(Event{Type: EventTextDelta, Delta: event.Delta})
		}
	case "response.output_item.done":
		if event.Item.Type == "message" {
			var text strings.Builder
			for _, content := range event.Item.Content {
				if content.Type == "output_text" {
					text.WriteString(content.Text)
				}
			}
			if text.Len() > 0 {
				result.Text = text.String()
				result.Outcome = OutcomeFinalText
			}
		}
	case "response.completed":
		*terminal = true
		result.Status = event.Response.Status
		if event.Response.ID != "" {
			result.ResponseID = event.Response.ID
		}
		result.Usage = Usage{
			InputTokens:  event.Response.Usage.InputTokens,
			OutputTokens: event.Response.Usage.OutputTokens,
			TotalTokens:  event.Response.Usage.TotalTokens,
		}
		if event.Response.Status != "completed" {
			return fmt.Errorf("the response completed with status %q", event.Response.Status)
		}
	case "response.failed", "response.incomplete", "error":
		return fmt.Errorf("the provider emitted terminal event %q", event.Type)
	}
	return nil
}
