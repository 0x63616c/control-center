package codex

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// The event shapes below are codex's, verified against rust-v0.145.0
// (codex-rs/exec/src/exec_events.rs). They are written out literally rather
// than built from a helper, because they are someone else's wire format and a
// test that constructed them the way the parser reads them would assert
// nothing.

func TestUsageIsCarriedExactlyAsCodexReportedIt(t *testing.T) {
	t.Parallel()

	// THE invariant of this parser. codex's input_tokens INCLUDES
	// cached_input_tokens, and reasoning_output_tokens is a SUBSET of
	// output_tokens. work.Usage documents that nesting, and internal/telemetry
	// relies on it: it subtracts the cached part to get a disjoint uncached
	// counter, and records reasoning as a subset of output. If a future edit
	// "helpfully" subtracts here as well, the cache hits are removed twice and
	// the billing figures go quietly wrong — no other test, dashboard or CI job
	// would notice. This one fails.
	stream := `{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":800,"cache_write_input_tokens":40,"output_tokens":300,"reasoning_output_tokens":250}}`

	outcome, err := parseStream(strings.NewReader(stream), func([]byte) {})
	if err != nil {
		t.Fatalf("parseStream() = %v", err)
	}

	want := work.Usage{InputTokens: 1000, CachedInputTokens: 800, OutputTokens: 300, ReasoningTokens: 250}
	if outcome.Usage != want {
		t.Errorf("Usage = %+v, want %+v — carry codex's numbers verbatim; internal/telemetry subtracts the cached part downstream to build its disjoint counters, so subtracting here too removes it twice", outcome.Usage, want)
	}
}

func TestUsageIsTotalledAcrossEveryTurn(t *testing.T) {
	t.Parallel()

	// A stage is one codex exec but not necessarily one turn. Reading only the
	// last turn.completed would under-report a stage that took several, and
	// under-reporting is the direction nobody notices.
	stream := join(
		`{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":1,"output_tokens":2,"reasoning_output_tokens":1}}`,
		`{"type":"turn.completed","usage":{"input_tokens":20,"cached_input_tokens":2,"output_tokens":4,"reasoning_output_tokens":2}}`,
	)

	outcome, err := parseStream(strings.NewReader(stream), func([]byte) {})
	if err != nil {
		t.Fatalf("parseStream() = %v", err)
	}

	want := work.Usage{InputTokens: 30, CachedInputTokens: 3, OutputTokens: 6, ReasoningTokens: 3}
	if outcome.Usage != want {
		t.Errorf("Usage = %+v, want the sum %+v", outcome.Usage, want)
	}
}

func TestThreadIDComesFromTheThreadThisStageStarted(t *testing.T) {
	t.Parallel()

	stream := join(
		`{"type":"thread.started","thread_id":"thr_first"}`,
		`{"type":"thread.started","thread_id":"thr_second"}`,
	)

	outcome, err := parseStream(strings.NewReader(stream), func([]byte) {})
	if err != nil {
		t.Fatalf("parseStream() = %v", err)
	}
	if outcome.ThreadID != "thr_first" {
		t.Errorf("ThreadID = %q, want %q — the first thread is the one this exec started; a later one is a sub-thread and correlating the transcript to it points at the wrong conversation", outcome.ThreadID, "thr_first")
	}
}

func TestAFailedTurnIsReportedWithItsCause(t *testing.T) {
	t.Parallel()

	stream := join(
		`{"type":"thread.started","thread_id":"thr_1"}`,
		`{"type":"turn.failed","error":{"message":"rate limit reached for gpt-5.6-terra"}}`,
	)

	outcome, err := parseStream(strings.NewReader(stream), func([]byte) {})
	if err != nil {
		t.Fatalf("parseStream() = %v", err)
	}
	if !strings.Contains(outcome.Failure, "rate limit reached") {
		t.Errorf("Failure = %q, want it to carry codex's own message — the breaker decides on this text", outcome.Failure)
	}
}

func TestATopLevelErrorIsAFailureToo(t *testing.T) {
	t.Parallel()

	// codex emits a bare `error` event for an unrecoverable stream error, which
	// is a different event from turn.failed. Reading only one of the two leaves
	// a stage that failed looking like a stage that produced nothing.
	outcome, err := parseStream(strings.NewReader(`{"type":"error","message":"stream disconnected"}`), func([]byte) {})
	if err != nil {
		t.Fatalf("parseStream() = %v", err)
	}
	if !strings.Contains(outcome.Failure, "stream disconnected") {
		t.Errorf("Failure = %q, want the error event's message", outcome.Failure)
	}
}

func TestEveryLineReachesTheSinkVerbatimAndUnterminated(t *testing.T) {
	t.Parallel()

	// The sink is the transcript and the activity heartbeat at once. Verbatim,
	// because a transcript that reformats what codex said is evidence of what
	// we thought it said; unterminated, because framing belongs to whoever
	// stores the stream (work.StageEventSink says so).
	lines := []string{
		`{"type":"thread.started","thread_id":"thr_1"}`,
		`{"type":"item.completed","item":{"id":"item_0","item_type":"assistant_message","text":"hi"}}`,
		`{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}`,
	}

	var seen []string
	if _, err := parseStream(strings.NewReader(join(lines...)), func(raw []byte) {
		seen = append(seen, string(raw))
	}); err != nil {
		t.Fatalf("parseStream() = %v", err)
	}

	if len(seen) != len(lines) {
		t.Fatalf("sink saw %d events, want %d", len(seen), len(lines))
	}
	for i, line := range lines {
		if seen[i] != line {
			t.Errorf("event %d reached the sink as %q, want %q", i, seen[i], line)
		}
	}
}

func TestAnEventTypeThisServiceHasNeverSeenIsStillRecorded(t *testing.T) {
	t.Parallel()

	// codex adds event types between releases. A parser that rejected unknown
	// ones would turn a routine CLI upgrade into every stage failing at once,
	// so unknown events are transcript material and nothing more.
	var seen int
	outcome, err := parseStream(strings.NewReader(join(
		`{"type":"turn.invented_tomorrow","payload":{"deep":[1,2,3]}}`,
		`{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}`,
	)), func([]byte) { seen++ })
	if err != nil {
		t.Fatalf("parseStream() = %v", err)
	}
	if seen != 2 {
		t.Errorf("sink saw %d events, want both", seen)
	}
	if outcome.Usage.InputTokens != 5 {
		t.Errorf("an unknown event stopped the parse; Usage = %+v", outcome.Usage)
	}
}

func TestALineThatIsNotJSONDoesNotThrowAwayTheStage(t *testing.T) {
	t.Parallel()

	// Anything a subprocess writes to stdout lands in this stream. Failing a
	// stage that has already run for forty minutes because one line was noise
	// costs quota to redo; the line is still kept, so the noise is visible in
	// the transcript rather than hidden by us.
	var seen int
	outcome, err := parseStream(strings.NewReader(join(
		`warning: something wrote to stdout`,
		`{"type":"turn.completed","usage":{"input_tokens":7,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}`,
	)), func([]byte) { seen++ })
	if err != nil {
		t.Fatalf("parseStream() = %v", err)
	}
	if seen != 2 {
		t.Errorf("sink saw %d lines, want both including the noise", seen)
	}
	if outcome.Usage.InputTokens != 7 {
		t.Errorf("a non-JSON line stopped the parse; Usage = %+v", outcome.Usage)
	}
}

func TestBlankLinesAreNotEvents(t *testing.T) {
	t.Parallel()

	var seen int
	if _, err := parseStream(strings.NewReader("\n\n"), func([]byte) { seen++ }); err != nil {
		t.Fatalf("parseStream() = %v", err)
	}
	if seen != 0 {
		t.Errorf("sink saw %d events for a stream of blank lines, want 0", seen)
	}
}

func TestAnEventLargerThanAScannerBufferIsStillRead(t *testing.T) {
	t.Parallel()

	// bufio.Scanner caps a token at 64KiB by default, and a single
	// item.completed carrying a model's full message goes past that easily. The
	// symptom would be a stage failing near the end, only on its longest and
	// most expensive runs.
	huge, err := json.Marshal(map[string]any{
		"type": "item.completed",
		"item": map[string]any{"id": "item_0", "text": strings.Repeat("x", 200_000)},
	})
	if err != nil {
		t.Fatalf("building the event: %v", err)
	}

	var seen []byte
	outcome, err := parseStream(strings.NewReader(string(huge)+"\n"+
		`{"type":"turn.completed","usage":{"input_tokens":9,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}`+"\n"),
		func(raw []byte) {
			if len(raw) > len(seen) {
				seen = append([]byte(nil), raw...)
			}
		})
	if err != nil {
		t.Fatalf("parseStream() = %v", err)
	}
	if len(seen) != len(huge) {
		t.Errorf("the largest event reached the sink as %d bytes, want %d", len(seen), len(huge))
	}
	if outcome.Usage.InputTokens != 9 {
		t.Errorf("parsing stopped after the large event; Usage = %+v", outcome.Usage)
	}
}

func TestAStreamWithNoEventsAtAllIsNotAFailureByItself(t *testing.T) {
	t.Parallel()

	// An empty stdout is exactly what a refresh-token failure looks like: codex
	// exits 1 having written only to stderr. The parser reports what it saw and
	// nothing more — deciding that empty means failure is the caller's job,
	// because only the caller has the exit code and the stderr to say why.
	outcome, err := parseStream(strings.NewReader(""), func([]byte) {})
	if err != nil {
		t.Fatalf("parseStream() = %v", err)
	}
	if outcome.Failure != "" || outcome.ThreadID != "" || outcome.Usage != (work.Usage{}) {
		t.Errorf("parseStream(empty) = %+v, want a zero outcome", outcome)
	}
}

func join(lines ...string) string {
	return strings.Join(lines, "\n") + "\n"
}
