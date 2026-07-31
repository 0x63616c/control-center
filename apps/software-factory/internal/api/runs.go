package api

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// usageOutput is the four token counts ADR-0012 fixes, rolled up across
// whatever level (Step, Run) requested them. Complete is false when the sum
// omits at least one unmeasured Attempt — the console must show that as
// "incomplete", never as a confident total that quietly left something out.
type usageOutput struct {
	InputTokens       int64 `json:"inputTokens" doc:"The whole input, including cachedInputTokens."`
	CachedInputTokens int64 `json:"cachedInputTokens" doc:"The part of inputTokens served from the provider's prompt cache."`
	OutputTokens      int64 `json:"outputTokens" doc:"The whole output, including reasoningTokens."`
	ReasoningTokens   int64 `json:"reasoningTokens" doc:"The part of outputTokens spent reasoning."`
	Complete          bool  `json:"complete" doc:"False when this total omits at least one unmeasured Attempt; render it as incomplete rather than a confident sum."`
}

// attemptOutput is one execution of a Step.
//
// Its four token fields are nullable scalars rather than a nested usageOutput
// object: huma has no supported way to mark a $ref'd object schema nullable
// (see schema.go's own panic on that combination), and there is nothing to
// roll up at this level — Complete only means something once more than one
// Attempt's numbers are summed, which happens at Step and Run, not here.
type attemptOutput struct {
	AttemptNo         int     `json:"attemptNo" doc:"Which attempt of this Step this is, starting at 1."`
	Model             string  `json:"model" doc:"The model this attempt ran on."`
	Effort            string  `json:"effort" doc:"The reasoning effort this attempt ran on."`
	Measured          bool    `json:"measured" doc:"Whether this attempt actually ran Codex. False means it resumed a stored result: the four token fields below are null, not zero, because nothing ran to measure."`
	InputTokens       *int64  `json:"inputTokens" doc:"The whole input, including cachedInputTokens. Null when measured is false."`
	CachedInputTokens *int64  `json:"cachedInputTokens" doc:"The part of inputTokens served from the provider's prompt cache. Null when measured is false."`
	OutputTokens      *int64  `json:"outputTokens" doc:"The whole output, including reasoningTokens. Null when measured is false."`
	ReasoningTokens   *int64  `json:"reasoningTokens" doc:"The part of outputTokens spent reasoning. Null when measured is false."`
	StartedAt         string  `json:"startedAt" doc:"RFC3339 UTC."`
	EndedAt           *string `json:"endedAt" doc:"RFC3339 UTC. Null until the attempt ends."`
	Result            string  `json:"result" doc:"'', 'succeeded' or 'failed'. Empty means the attempt has not ended yet." enum:",succeeded,failed"`
	HasTranscript     bool    `json:"hasTranscript" doc:"Whether a transcript is stored for this attempt."`
}

// stepOutput is one instance of a Stage inside a Run, identified by its turn.
type stepOutput struct {
	Stage     string          `json:"stage" doc:"plan, implement, or review." enum:"plan,implement,review"`
	Turn      int             `json:"turn" doc:"Which turn of Stage this is within the Run, starting at 1 — the headline number: the model was asked to do this work again."`
	StartedAt string          `json:"startedAt" doc:"RFC3339 UTC. Its first Attempt's start."`
	EndedAt   *string         `json:"endedAt" doc:"RFC3339 UTC. Null while its last Attempt is still running."`
	Attempts  []attemptOutput `json:"attempts" doc:"This Step's attempts, oldest first. Usually one; more than one means a machine retry, not semantic re-work."`
	Usage     usageOutput     `json:"usage" doc:"Rolled up across this Step's Attempts."`
}

// runOutput is one attempt at a whole Ticket.
type runOutput struct {
	ID          string       `json:"id" doc:"Temporal's run id for this Run."`
	TicketID    int64        `json:"ticketId" doc:"The Ticket this Run belongs to."`
	StartedAt   string       `json:"startedAt" doc:"RFC3339 UTC."`
	EndedAt     *string      `json:"endedAt" doc:"RFC3339 UTC. Null until the Run ends."`
	Outcome     string       `json:"outcome" doc:"'', 'proposed', 'blocked', 'exhausted' or 'failed'. Empty until the Run ends." enum:",proposed,blocked,exhausted,failed"`
	FailureKind string       `json:"failureKind" doc:"'', 'auth', 'rate-limit' or 'other'." enum:",auth,rate-limit,other"`
	Steps       []stepOutput `json:"steps" doc:"This Run's Steps, in pipeline order."`
	Usage       usageOutput  `json:"usage" doc:"Rolled up across this Run's Steps."`
}

type ticketRunsInput struct {
	TicketID int64 `path:"ticketID" minimum:"1" doc:"The Ticket identifier."`
}

type ticketRunsOutput struct {
	Body struct {
		Runs []runOutput `json:"runs" doc:"This Ticket's Runs, most recent first."`
	}
}

// getTicketRuns returns every Run of a Ticket, each with its Steps and
// Attempts and rolled-up token usage — the console's ticket detail view.
func (service *Service) getTicketRuns(ctx context.Context, input *ticketRunsInput) (*ticketRunsOutput, error) {
	if service.tickets == nil {
		return nil, clientError(http.StatusServiceUnavailable, "store_unavailable", "ticket store is not configured")
	}
	ticketID := store.TicketID(input.TicketID)
	if _, err := service.ticket(ctx, ticketID); err != nil {
		return nil, ticketStoreError(err)
	}
	runs, err := service.tickets.RunsForTicket(ctx, ticketID)
	if err != nil {
		return nil, ticketStoreError(err)
	}
	output := &ticketRunsOutput{}
	for _, run := range runs {
		detail, err := service.tickets.RunDetail(ctx, run.ID)
		if err != nil {
			return nil, ticketStoreError(err)
		}
		transcripts, err := service.tickets.TranscriptKeysForRun(ctx, run.ID)
		if err != nil {
			return nil, ticketStoreError(err)
		}
		output.Body.Runs = append(output.Body.Runs, runOutputFrom(detail, transcriptSet(transcripts)))
	}
	return output, nil
}

// transcriptSet indexes keys for a fast hasTranscript lookup per Attempt.
func transcriptSet(keys []store.TranscriptKey) map[store.TranscriptKey]bool {
	set := make(map[store.TranscriptKey]bool, len(keys))
	for _, k := range keys {
		set[k] = true
	}
	return set
}

func runOutputFrom(detail store.RunDetail, transcripts map[store.TranscriptKey]bool) runOutput {
	usage, complete := detail.Usage()
	out := runOutput{
		ID:          detail.Run.ID,
		TicketID:    int64(detail.Run.TicketID),
		StartedAt:   wireTime(detail.Run.StartedAt),
		EndedAt:     optionalWireTime(detail.Run.EndedAt),
		Outcome:     string(detail.Run.Outcome),
		FailureKind: string(detail.Run.Failure),
		Usage:       usageOutputFrom(usage, complete),
	}
	for _, step := range detail.Steps {
		out.Steps = append(out.Steps, stepOutputFrom(step, transcripts))
	}
	return out
}

func stepOutputFrom(step store.StepDetail, transcripts map[store.TranscriptKey]bool) stepOutput {
	usage, complete := step.Usage()
	out := stepOutput{
		Stage: string(step.Stage),
		Turn:  step.Turn,
		Usage: usageOutputFrom(usage, complete),
	}
	if len(step.Attempts) > 0 {
		out.StartedAt = wireTime(step.Attempts[0].StartedAt)
		out.EndedAt = optionalWireTime(step.Attempts[len(step.Attempts)-1].EndedAt)
	}
	for _, attempt := range step.Attempts {
		key := store.TranscriptKey{Stage: step.Stage, Turn: step.Turn, AttemptNo: attempt.AttemptNo}
		out.Attempts = append(out.Attempts, attemptOutputFrom(attempt, transcripts[key]))
	}
	return out
}

func attemptOutputFrom(attempt store.Attempt, hasTranscript bool) attemptOutput {
	out := attemptOutput{
		AttemptNo:     attempt.AttemptNo,
		Model:         attempt.Model.Name,
		Effort:        attempt.Model.Effort,
		Measured:      attempt.Measured,
		StartedAt:     wireTime(attempt.StartedAt),
		EndedAt:       optionalWireTime(attempt.EndedAt),
		Result:        string(attempt.Result),
		HasTranscript: hasTranscript,
	}
	if attempt.Measured {
		out.InputTokens = &attempt.Usage.InputTokens
		out.CachedInputTokens = &attempt.Usage.CachedInputTokens
		out.OutputTokens = &attempt.Usage.OutputTokens
		out.ReasoningTokens = &attempt.Usage.ReasoningTokens
	}
	return out
}

func usageOutputFrom(usage work.Usage, complete bool) usageOutput {
	return usageOutput{
		InputTokens:       usage.InputTokens,
		CachedInputTokens: usage.CachedInputTokens,
		OutputTokens:      usage.OutputTokens,
		ReasoningTokens:   usage.ReasoningTokens,
		Complete:          complete,
	}
}

// optionalWireTime renders t as RFC3339 UTC, or nil for the zero time — the
// convention EndedAt uses everywhere: zero means "has not ended yet", not
// the Unix epoch.
func optionalWireTime(t time.Time) *string {
	if t.IsZero() {
		return nil
	}
	formatted := wireTime(t)
	return &formatted
}

type ticketRunTranscriptInput struct {
	TicketID  int64  `path:"ticketID" minimum:"1" doc:"The Ticket identifier."`
	RunID     string `path:"runID" doc:"The Run's Temporal run id."`
	Stage     string `path:"stage" enum:"plan,implement,review" doc:"The Stage of the Step this Attempt belongs to."`
	Turn      int    `path:"turn" minimum:"1" doc:"The Step's turn number."`
	AttemptNo int    `path:"attemptNo" minimum:"1" doc:"Which attempt of the Step to download."`
}

type transcriptOutput struct {
	ContentType        string `header:"Content-Type"`
	ContentDisposition string `header:"Content-Disposition"`
	Body               []byte
}

// getAttemptTranscript downloads one Attempt's decompressed JSONL transcript.
func (service *Service) getAttemptTranscript(ctx context.Context, input *ticketRunTranscriptInput) (*transcriptOutput, error) {
	if service.tickets == nil {
		return nil, clientError(http.StatusServiceUnavailable, "store_unavailable", "ticket store is not configured")
	}
	run, err := service.tickets.Run(ctx, input.RunID)
	if err != nil {
		return nil, ticketStoreError(err)
	}
	if run.TicketID != store.TicketID(input.TicketID) {
		return nil, clientError(http.StatusNotFound, "not_found", "run does not belong to this ticket")
	}
	key := work.StageKey{Ticket: int(run.TicketID), RunID: input.RunID, Stage: work.Stage(input.Stage), Turn: input.Turn}
	transcript, err := service.tickets.Transcript(ctx, key, input.AttemptNo)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, clientError(http.StatusNotFound, "not_found", "no transcript is stored for this attempt")
		}
		return nil, ticketStoreError(err)
	}
	raw, err := decompress(transcript)
	if err != nil {
		return nil, clientError(http.StatusInternalServerError, "internal", err.Error())
	}
	filename := fmt.Sprintf("ticket-%d-%s-turn%d-attempt%d-%s.jsonl",
		run.TicketID, input.Stage, input.Turn, input.AttemptNo, input.RunID)
	return &transcriptOutput{
		ContentType:        "application/x-ndjson",
		ContentDisposition: fmt.Sprintf(`attachment; filename="%s"`, filename),
		Body:               raw,
	}, nil
}

// decompress inflates t's stored bytes. gzip is the only codec
// PersistTranscriptToStore writes today; an unrecognised value is a stored
// row this API does not know how to read, not something to guess at.
func decompress(t store.Transcript) ([]byte, error) {
	switch t.Compression {
	case "gzip":
		reader, err := gzip.NewReader(bytes.NewReader(t.CompressedBytes))
		if err != nil {
			return nil, fmt.Errorf("opening gzip transcript: %w", err)
		}
		defer func() { _ = reader.Close() }()
		raw, err := io.ReadAll(reader)
		if err != nil {
			return nil, fmt.Errorf("reading gzip transcript: %w", err)
		}
		return raw, nil
	default:
		return nil, fmt.Errorf("transcript uses unknown compression %q", t.Compression)
	}
}
