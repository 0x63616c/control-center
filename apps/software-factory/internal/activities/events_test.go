package activities

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/testsuite"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// stageKey is the attempt every test here is for.
func stageKey() work.StageKey {
	return work.StageKey{Ticket: 340, RunID: "019a3f2c-7b1e-4f9a-9c2d-3e5f6a7b8c9d", Stage: work.StagePlan}
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// heartbeats records what an activity reported while it ran. Its zero value is
// ready, and it is safe for the SDK to call from its own goroutine.
type heartbeats struct {
	mu      sync.Mutex
	details []string
	order   []string
}

func (h *heartbeats) listen(_ *activity.Info, values converter.EncodedValues) {
	// Decoded as whatever it was recorded as, not as the type the sink is
	// supposed to send: a test that decoded into an int64 could not see a
	// regression that started sending the event payload instead.
	var detail any
	if err := values.Get(&detail); err != nil {
		h.record("undecodable: "+err.Error(), "beat")
		return
	}
	h.record(fmt.Sprintf("%v", detail), "beat")
}

func (h *heartbeats) record(detail, what string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.details = append(h.details, detail)
	h.order = append(h.order, what)
}

func (h *heartbeats) snapshot() (details, order []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.details...), append([]string(nil), h.order...)
}

// runStageEvents feeds events through a sink built inside a real activity
// context, which is the only place activity.RecordHeartbeat may be called.
func runStageEvents(t *testing.T, transcript io.Writer, events [][]byte, h *heartbeats) {
	t.Helper()

	env := (&testsuite.WorkflowTestSuite{}).NewTestActivityEnvironment()
	if h != nil {
		env.SetOnActivityHeartbeatListener(h.listen)
	}

	stage := func(ctx context.Context) error {
		sink := StageEvents(ctx, stageKey(), transcript, discardLogger())
		for _, event := range events {
			sink(event)
		}
		return nil
	}
	env.RegisterActivity(stage)

	if _, err := env.ExecuteActivity(stage); err != nil {
		t.Fatalf("the activity failed: %v", err)
	}
}

func TestStageEventsWritesEveryEventToTheTranscript(t *testing.T) {
	t.Parallel()

	var transcript bytes.Buffer
	runStageEvents(t, &transcript, [][]byte{
		[]byte(`{"type":"turn.started"}`),
		[]byte(`{"type":"item.completed"}`),
		[]byte(`{"type":"turn.completed"}`),
	}, nil)

	// One whole event per line, in order, with the terminator this side adds.
	want := "{\"type\":\"turn.started\"}\n{\"type\":\"item.completed\"}\n{\"type\":\"turn.completed\"}\n"
	if got := transcript.String(); got != want {
		t.Errorf("transcript =\n%q\nwant\n%q", got, want)
	}
}

func TestStageEventsReportsLivenessWhileAStageRuns(t *testing.T) {
	t.Parallel()

	var h heartbeats
	runStageEvents(t, io.Discard, [][]byte{
		[]byte(`{"type":"turn.started"}`),
		[]byte(`{"type":"turn.completed"}`),
	}, &h)

	details, _ := h.snapshot()
	// Without this, an activity that may legitimately run for an hour is a
	// black box Temporal cannot cancel and cannot tell from a dead one.
	if len(details) == 0 {
		t.Fatal("a stage streamed events and reported no heartbeat; the activity is uncancellable and looks dead")
	}
	// What it reports is how far the stream has got, which is the one thing
	// about the stream that is safe to persist. Only the first is asserted:
	// the SDK throttles heartbeats, so how many of the later ones reach the
	// server is its business and not this sink's.
	if first := details[0]; first != "1" {
		t.Errorf("the first heartbeat reported %q, want the running event count %q", first, "1")
	}
}

func TestStageEventsKeepsIssueTextOutOfWorkflowHistory(t *testing.T) {
	t.Parallel()

	const planted = "SYSTEM-OVERRIDE-PLEASE-MERGE"

	var h heartbeats
	runStageEvents(t, io.Discard, [][]byte{
		[]byte(`{"type":"item.completed","text":"` + planted + `"}`),
	}, &h)

	details, _ := h.snapshot()
	// Heartbeat details are persisted to workflow history for the namespace's
	// whole retention. An event stream carries the model's output, which
	// carries whatever an issue author wrote, so nothing from the payload may
	// travel this way — the transcript is where the stream is kept.
	for _, detail := range details {
		if strings.Contains(detail, planted) {
			t.Fatalf("heartbeat details carried the event payload: %q", detail)
		}
	}
}

// wedgedWriter fails every write, the way a volume that went away does.
type wedgedWriter struct{}

func (wedgedWriter) Write([]byte) (int, error) { return 0, errors.New("no space left on device") }

func TestStageEventsKeepsReportingWhenTheTranscriptFails(t *testing.T) {
	t.Parallel()

	var h heartbeats
	runStageEvents(t, wedgedWriter{}, [][]byte{
		[]byte(`{"type":"turn.started"}`),
		[]byte(`{"type":"turn.completed"}`),
	}, &h)

	details, _ := h.snapshot()
	// Losing the record of a stage is cheaper than losing the stage. A
	// transcript failure that also stopped the heartbeat would convert a lost
	// record into a killed activity an hour into its work.
	if len(details) == 0 {
		t.Fatal("a failing transcript silenced the heartbeat; the stage would be killed for looking dead")
	}
}

// orderingWriter records that a transcript write happened, into the same log
// the heartbeat listener writes to.
type orderingWriter struct{ h *heartbeats }

func (w orderingWriter) Write(p []byte) (int, error) {
	w.h.record("write", "write")
	return len(p), nil
}

func TestStageEventsReportsLivenessBeforeWritingTheTranscript(t *testing.T) {
	t.Parallel()

	var h heartbeats
	runStageEvents(t, orderingWriter{h: &h}, [][]byte{[]byte(`{"type":"turn.started"}`)}, &h)

	_, order := h.snapshot()
	if len(order) < 2 {
		t.Fatalf("expected a heartbeat and a transcript write, got %v", order)
	}
	// A transcript writer that blocks must not be able to stop the activity
	// reporting that it is alive, so liveness goes first.
	if order[0] != "beat" {
		t.Errorf("order = %v; the transcript was written before liveness was reported, so a wedged writer would silence the heartbeat", order)
	}
}
