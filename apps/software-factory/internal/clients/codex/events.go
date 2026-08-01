package codex

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// The event names and field names below are codex's, not ours. Verified
// against rust-v0.145.0 (codex-rs/exec/src/exec_events.rs): the stream is
// JSONL, one object per line, discriminated by a "type" field.
const (
	eventThreadStarted = "thread.started"
	eventTurnCompleted = "turn.completed"
	eventTurnFailed    = "turn.failed"
	eventError         = "error"
)

// outcome is everything a stage's event stream says about how the stage went.
//
// It says nothing about whether the stage succeeded. Success is the exit code's
// to report, and the caller holds that along with stderr — which is the only
// place the most likely real failure, an expired refresh token, appears at all.
type outcome struct {
	// ThreadID is codex's own identifier for the conversation, recorded so a
	// stored transcript can be correlated with the provider's records.
	ThreadID string

	// Usage totals every turn in the stage, exactly as codex reported it. The
	// nesting work.Usage documents is preserved here: cached input stays inside
	// the input total and reasoning stays inside the output total.
	Usage work.Usage

	// Failure is codex's own message for a turn that failed or a stream that
	// errored, and empty if neither happened.
	Failure string
}

// event is the part of a codex event this service reads. Everything else in the
// stream is transcript material, so nothing here needs to model it.
type event struct {
	Type     string `json:"type"`
	ThreadID string `json:"thread_id"`
	Message  string `json:"message"`
	Usage    *usage `json:"usage"`
	Error    *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// ThreadIDFromEvent extracts only a top-level provider thread-start identity.
// Run Worker checkpointing uses it before the provider process can finish.
func ThreadIDFromEvent(raw []byte) string {
	var e event
	if err := json.Unmarshal(raw, &e); err != nil || e.Type != eventThreadStarted {
		return ""
	}
	return e.ThreadID
}

// usage mirrors codex's per-turn token counts, field for field.
//
// It is a separate type from work.Usage and mapped explicitly below, so codex's
// spelling stays sealed in this package — the CLI calls the last one
// reasoning_output_tokens, and a shared struct would put that name in the
// domain vocabulary and make renaming it a change to every consumer.
//
// cache_write_input_tokens is deliberately absent: nothing prices or reports it
// yet, and a field carried but never read reads like an output nobody checked.
//
// There is no total_tokens here, and its absence is not an oversight. A session
// file under CODEX_HOME carries one — a different struct, protocol::TokenUsage
// — so anyone checking these names against a session transcript will find a
// field this stream never emits, and adding it would silently read zero.
type usage struct {
	InputTokens         int64 `json:"input_tokens"`
	CachedInputTokens   int64 `json:"cached_input_tokens"`
	OutputTokens        int64 `json:"output_tokens"`
	ReasoningOutputToks int64 `json:"reasoning_output_tokens"`
}

// parseStream reads a `codex exec --json` stream, forwarding every line to the
// sink and extracting what the run needs from it.
//
// It is deliberately lenient about what it does not understand and strict about
// nothing. A line that is not JSON, and an event type that did not exist when
// this was written, are both forwarded and then ignored: codex adds event types
// between releases, and anything a subprocess writes to stdout lands in this
// stream, so rejecting either would fail stages for reasons unrelated to the
// work — after they have already been paid for.
//
// It returns an error only when the stream itself could not be read, because
// that means the output is truncated and the totals below are a lower bound
// rather than an answer.
func parseStream(r io.Reader, sink work.StageEventSink) (outcome, error) {
	var result outcome
	reader := bufio.NewReader(r)

	for {
		line, err := readLine(reader)
		if len(line) > 0 {
			result.observe(line, sink)
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return result, nil
			}
			return result, fmt.Errorf("reading the codex event stream: %w", err)
		}
	}
}

// observe forwards one raw line and folds whatever it understands into the
// outcome.
func (o *outcome) observe(line []byte, sink work.StageEventSink) {
	sink(line)

	var e event
	if err := json.Unmarshal(line, &e); err != nil {
		return
	}

	switch e.Type {
	case eventThreadStarted:
		// First wins. A later thread.started is a sub-thread, and correlating
		// this stage's transcript with it would name the wrong conversation.
		if o.ThreadID == "" {
			o.ThreadID = e.ThreadID
		}
	case eventTurnCompleted:
		if e.Usage != nil {
			o.Usage = o.Usage.Add(e.Usage.domain())
		}
	case eventTurnFailed:
		if e.Error != nil {
			o.noteFailure(e.Error.Message)
		}
	case eventError:
		o.noteFailure(e.Message)
	}
}

// noteFailure keeps the first failure the stream reported. Later ones are
// usually the first one's consequences, and the cause is what the breaker and
// the reader of a status comment both need.
func (o *outcome) noteFailure(message string) {
	if o.Failure != "" {
		return
	}
	if message = strings.TrimSpace(message); message != "" {
		o.Failure = message
	}
}

// domain converts codex's token counts to the domain's.
//
// It copies them across and does not compute. work.Usage documents that
// InputTokens includes CachedInputTokens and OutputTokens includes
// ReasoningTokens, and that nesting is codex's own (verified against
// rust-v0.145.0: non_cached_input() subtracts one from the other, and
// blended_total() adds output once without adding reasoning). Subtracting
// either here would be invisible, because internal/telemetry reads them as
// nested — and the two go wrong in different ways, which is why neither is
// safe to "tidy up" here.
//
// Cached: telemetry subtracts it to build a disjoint uncachedInput counter, so
// subtracting here too removes the same tokens twice.
//
// Reasoning: telemetry does NOT subtract it — it records it whole, as a subset
// of an output counter it also records whole. Subtracting here would not
// double-subtract; it would make the output counter undercount and quietly
// break the reasoning ⊆ output relation the two counters are documented to
// have.
//
// Both come out low on a dashboard nobody can check against a bill.
func (u usage) domain() work.Usage {
	return work.Usage{
		InputTokens:       u.InputTokens,
		CachedInputTokens: u.CachedInputTokens,
		OutputTokens:      u.OutputTokens,
		ReasoningTokens:   u.ReasoningOutputToks,
	}
}

// readLine returns one line without its terminator.
//
// bufio.Scanner is not used: it caps a token at 64KiB, and one item.completed
// carrying a model's full message goes past that easily — which would fail a
// stage only on its longest and most expensive runs. A line here is bounded by
// what the model produced, which the run is already paying to hold.
func readLine(reader *bufio.Reader) ([]byte, error) {
	line, err := reader.ReadBytes('\n')
	return bytes.TrimRight(line, "\r\n"), err
}
