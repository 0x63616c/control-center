package api

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store/storefake"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// runsResponse mirrors the wire shape enough for these tests to assert on it
// without hand-decoding raw JSON at every call site.
type runsResponse struct {
	Runs []struct {
		ID          string  `json:"id"`
		TicketID    int64   `json:"ticketId"`
		StartedAt   string  `json:"startedAt"`
		EndedAt     *string `json:"endedAt"`
		Outcome     string  `json:"outcome"`
		FailureKind string  `json:"failureKind"`
		Usage       struct {
			InputTokens int64 `json:"inputTokens"`
			Complete    bool  `json:"complete"`
		} `json:"usage"`
		Steps []struct {
			Stage    string `json:"stage"`
			Turn     int    `json:"turn"`
			Attempts []struct {
				AttemptNo     int    `json:"attemptNo"`
				Measured      bool   `json:"measured"`
				InputTokens   *int64 `json:"inputTokens"`
				HasTranscript bool   `json:"hasTranscript"`
			} `json:"attempts"`
		} `json:"steps"`
	} `json:"runs"`
}

// transcriptFor builds the store.Transcript row for key's attemptNo, given
// already-compressed bytes.
func transcriptFor(key work.StageKey, attemptNo int, compressed []byte) store.Transcript {
	return store.Transcript{Key: key, AttemptNo: attemptNo, CompressedBytes: compressed, Compression: "gzip"}
}

func TestGetTicketRunsRollsUpUsageAndFlagsIncompleteRuns(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	fake := storefake.New()
	service := New("test-build", nil, fake)

	ticket, err := fake.CreateTicket(ctx, "T", "body", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	runID := "11111111-1111-1111-1111-111111111111"
	started := time.Date(2026, 7, 31, 10, 0, 0, 0, time.UTC)
	if _, err := fake.StartRun(ctx, runID, ticket.ID, started); err != nil {
		t.Fatalf("StartRun: %v", err)
	}
	key := work.StageKey{Ticket: int(ticket.ID), RunID: runID, Stage: work.StageImplement, Turn: 1}
	if err := fake.RecordStep(ctx, key); err != nil {
		t.Fatalf("RecordStep: %v", err)
	}
	// Attempt 1 measured with real usage.
	if _, err := fake.RecordAttempt(ctx, key, 1, work.Model{Name: "gpt-5.6", Effort: "medium"},
		work.Usage{InputTokens: 100, CachedInputTokens: 10, OutputTokens: 40, ReasoningTokens: 5}, true, started); err != nil {
		t.Fatalf("RecordAttempt(1): %v", err)
	}
	// Attempt 2 resumed: not measured, zero usage — the #426 case.
	if _, err := fake.RecordAttempt(ctx, key, 2, work.Model{}, work.Usage{}, false, started.Add(time.Minute)); err != nil {
		t.Fatalf("RecordAttempt(2): %v", err)
	}

	response := ticketRequest(t, service, http.MethodGet, "/v1/tickets/1/runs", "")
	if response.Code != http.StatusOK {
		t.Fatalf("GET runs status = %d: %s", response.Code, response.Body.String())
	}

	var body runsResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (%s)", err, response.Body.String())
	}
	if len(body.Runs) != 1 {
		t.Fatalf("runs = %d, want 1", len(body.Runs))
	}
	run := body.Runs[0]
	if run.ID != runID || run.TicketID != int64(ticket.ID) {
		t.Fatalf("run identity = %+v", run)
	}
	if run.Usage.Complete {
		t.Fatalf("run usage complete = true, want false: attempt 2 was never measured")
	}
	if run.Usage.InputTokens != 100 {
		t.Fatalf("run usage inputTokens = %d, want 100 (only the measured attempt)", run.Usage.InputTokens)
	}
	if len(run.Steps) != 1 || len(run.Steps[0].Attempts) != 2 {
		t.Fatalf("steps = %+v, want one step with two attempts", run.Steps)
	}
	second := run.Steps[0].Attempts[1]
	if second.Measured {
		t.Fatalf("attempt 2 measured = true, want false")
	}
	if second.InputTokens != nil {
		t.Fatalf("attempt 2 inputTokens = %d, want null: an unmeasured attempt's usage is unknown, not zero", *second.InputTokens)
	}
	if second.HasTranscript {
		t.Fatalf("attempt 2 hasTranscript = true, want false: none was stored")
	}
}

func TestGetTicketRunsForAnUnknownTicketIs404(t *testing.T) {
	t.Parallel()
	service := New("test-build", nil, storefake.New())
	response := ticketRequest(t, service, http.MethodGet, "/v1/tickets/999/runs", "")
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404: %s", response.Code, response.Body.String())
	}
}

func TestDownloadAttemptTranscriptDecompressesGzip(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	fake := storefake.New()
	service := New("test-build", nil, fake)

	ticket, err := fake.CreateTicket(ctx, "T", "body", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	runID := "22222222-2222-2222-2222-222222222222"
	started := time.Date(2026, 7, 31, 11, 0, 0, 0, time.UTC)
	if _, err := fake.StartRun(ctx, runID, ticket.ID, started); err != nil {
		t.Fatalf("StartRun: %v", err)
	}
	key := work.StageKey{Ticket: int(ticket.ID), RunID: runID, Stage: work.StagePlan, Turn: 1}
	if err := fake.RecordStep(ctx, key); err != nil {
		t.Fatalf("RecordStep: %v", err)
	}
	if _, err := fake.RecordAttempt(ctx, key, 1, work.Model{Name: "m", Effort: "e"}, work.Usage{}, true, started); err != nil {
		t.Fatalf("RecordAttempt: %v", err)
	}

	raw := []byte(`{"event":"one"}` + "\n" + `{"event":"two"}` + "\n")
	var compressed bytes.Buffer
	gz := gzip.NewWriter(&compressed)
	if _, err := gz.Write(raw); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	if err := fake.PutTranscript(ctx, transcriptFor(key, 1, compressed.Bytes())); err != nil {
		t.Fatalf("PutTranscript: %v", err)
	}

	// Confirm the run listing now reports the transcript as present.
	runs := ticketRequest(t, service, http.MethodGet, "/v1/tickets/1/runs", "")
	var body runsResponse
	if err := json.Unmarshal(runs.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode runs: %v", err)
	}
	if !body.Runs[0].Steps[0].Attempts[0].HasTranscript {
		t.Fatalf("hasTranscript = false, want true once a transcript is stored")
	}

	response := ticketRequest(t, service, http.MethodGet, "/v1/tickets/1/runs/"+runID+"/stages/plan/turns/1/attempts/1/transcript", "")
	if response.Code != http.StatusOK {
		t.Fatalf("download status = %d: %s", response.Code, response.Body.String())
	}
	if response.Body.String() != string(raw) {
		t.Fatalf("download body = %q, want the decompressed transcript %q", response.Body.String(), raw)
	}
	if disposition := response.Header().Get("Content-Disposition"); disposition == "" {
		t.Fatalf("Content-Disposition header is empty, want an attachment filename")
	}
}

func TestDownloadAttemptTranscriptForWrongTicketIs404(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	fake := storefake.New()
	service := New("test-build", nil, fake)

	_, err := fake.CreateTicket(ctx, "A", "body", nil)
	if err != nil {
		t.Fatalf("CreateTicket(A): %v", err)
	}
	other, err := fake.CreateTicket(ctx, "B", "body", nil)
	if err != nil {
		t.Fatalf("CreateTicket(B): %v", err)
	}
	runID := "33333333-3333-3333-3333-333333333333"
	if _, err := fake.StartRun(ctx, runID, other.ID, time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("StartRun: %v", err)
	}

	// runID belongs to ticket B; asking for it under ticket A's path is a 404,
	// not a leak of another ticket's run.
	response := ticketRequest(t, service, http.MethodGet, "/v1/tickets/1/runs/"+runID+"/stages/plan/turns/1/attempts/1/transcript", "")
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404: %s", response.Code, response.Body.String())
	}
}
