package store

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store/storedb"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/jackc/pgx/v5"
)

// ErrTicketClaimed reports that another target Run owns a Ticket.
var ErrTicketClaimed = errors.New("ticket already has an active run")

// ErrRunOwnership reports a terminal operation naming a stale owner.
var ErrRunOwnership = errors.New("run does not own ticket")

// TargetRunClaimer is the target workflow's atomic admission boundary.
type TargetRunClaimer interface {
	ClaimAndStartRun(context.Context, ClaimRunInput) (ClaimRunResult, error)
}

// TargetStepRecorder records mandatory target Step lifecycle boundaries.
type TargetStepRecorder interface {
	StartStep(context.Context, StartStepInput) (RunStep, error)
	CompleteStep(context.Context, string, int, time.Time, json.RawMessage) (RunStep, error)
}

// TargetAgentRecorder records durable agent authorization and checkpoint boundaries.
type TargetAgentRecorder interface {
	StartAgentAttempt(context.Context, StartAgentAttemptInput) (AgentAttempt, error)
	CheckpointAgentAttempt(context.Context, AgentCheckpointInput) (AgentAttempt, error)
}

// TargetTerminalRecorder records irreversible and cancellation outcomes.
type TargetTerminalRecorder interface {
	FinalizeConfirmedMerge(context.Context, ConfirmedMergeInput) (TerminalResult, error)
	CancelRun(context.Context, CancelRunInput) (TerminalResult, error)
}

// ClaimRunInput is the stable identity for an atomic target claim.
type ClaimRunInput struct {
	TicketID  TicketID
	RunID     string
	StartedAt time.Time
}

// ClaimRunResult is the Ticket and Run committed by one target claim.
type ClaimRunResult struct {
	Ticket Ticket
	Run    Run
}

// ClaimAndStartRun atomically claims an open Ticket and creates its owning Run.
// Repeating the same identity returns the original owner; a different Run never
// observes partial ownership or creates a second durable Run.
func (s *Store) ClaimAndStartRun(ctx context.Context, in ClaimRunInput) (ClaimRunResult, error) {
	if s.begin == nil {
		return ClaimRunResult{}, fmt.Errorf("claiming ticket %d: store cannot begin a transaction", in.TicketID)
	}
	runID, err := pgUUID(in.RunID)
	if err != nil {
		return ClaimRunResult{}, fmt.Errorf("claiming ticket %d: %w", in.TicketID, err)
	}
	tx, err := s.begin.Begin(ctx)
	if err != nil {
		return ClaimRunResult{}, fmt.Errorf("claiming ticket %d: beginning transaction: %w", in.TicketID, wrapQueryErr(err))
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	ticketRow, err := q.TicketForTargetClaim(ctx, int64(in.TicketID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ClaimRunResult{}, fmt.Errorf("claiming ticket %d: %w", in.TicketID, ErrNotFound)
		}
		return ClaimRunResult{}, fmt.Errorf("claiming ticket %d: %w", in.TicketID, wrapQueryErr(err))
	}
	ticket, err := ticketFromRow(ticketRow)
	if err != nil {
		return ClaimRunResult{}, err
	}
	if ticket.State == TicketActive {
		if ticket.ActiveRunID != in.RunID {
			return ClaimRunResult{}, fmt.Errorf("claiming ticket %d: %w", in.TicketID, ErrTicketClaimed)
		}
		runRow, runErr := q.TargetRunForUpdate(ctx, runID)
		if runErr != nil {
			return ClaimRunResult{}, fmt.Errorf("claiming ticket %d: reading retried run: %w", in.TicketID, wrapQueryErr(runErr))
		}
		if runRow.TicketID != int64(in.TicketID) {
			return ClaimRunResult{}, fmt.Errorf("claiming ticket %d: %w", in.TicketID, work.ErrPermanent)
		}
		if err := tx.Commit(ctx); err != nil {
			return ClaimRunResult{}, fmt.Errorf("claiming ticket %d: committing retry: %w", in.TicketID, wrapQueryErr(err))
		}
		return ClaimRunResult{Ticket: ticket, Run: runFromRow(runRow)}, nil
	}
	if ticket.State != TicketOpen {
		return ClaimRunResult{}, fmt.Errorf("claiming ticket %d in %s: %w", in.TicketID, ticket.State, ErrTicketClaimed)
	}
	runRow, err := q.InsertTargetRun(ctx, storedb.InsertTargetRunParams{ID: runID, TicketID: int64(in.TicketID), StartedAt: pgTimestamp(in.StartedAt)})
	if err != nil {
		return ClaimRunResult{}, fmt.Errorf("claiming ticket %d: inserting run: %w", in.TicketID, wrapQueryErr(err))
	}
	if runRow.TicketID != int64(in.TicketID) {
		return ClaimRunResult{}, fmt.Errorf("claiming ticket %d: run id belongs to another ticket: %w", in.TicketID, work.ErrPermanent)
	}
	activeRow, err := q.ActivateTargetTicket(ctx, storedb.ActivateTargetTicketParams{ID: int64(in.TicketID), ActiveRunID: runID})
	if err != nil {
		return ClaimRunResult{}, fmt.Errorf("claiming ticket %d: activating: %w", in.TicketID, wrapQueryErr(err))
	}
	active, err := ticketFromRow(activeRow)
	if err != nil {
		return ClaimRunResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ClaimRunResult{}, fmt.Errorf("claiming ticket %d: committing: %w", in.TicketID, wrapQueryErr(err))
	}
	return ClaimRunResult{Ticket: active, Run: runFromRow(runRow)}, nil
}

// RunStep is a target ordinal Step, independent of agent execution.
type RunStep struct {
	RunID     string
	Ordinal   int
	Kind      work.StepKind
	Iteration int
	Reason    string
	State     work.StepState
	StartedAt time.Time
	EndedAt   time.Time
	Result    json.RawMessage
}

// StartStepInput starts one idempotent target Step.
type StartStepInput struct {
	RunID     string
	Ordinal   int
	Kind      work.StepKind
	Iteration int
	Reason    string
	StartedAt time.Time
}

// StartStep persists one mandatory primary-operation boundary.
func (s *Store) StartStep(ctx context.Context, in StartStepInput) (RunStep, error) {
	runID, err := pgUUID(in.RunID)
	if err != nil {
		return RunStep{}, fmt.Errorf("starting step %d: %w", in.Ordinal, err)
	}
	row, err := s.q.StartTargetStep(ctx, storedb.StartTargetStepParams{RunID: runID, Ordinal: int32(in.Ordinal), Kind: string(in.Kind), Iteration: int32(in.Iteration), Reason: in.Reason, StartedAt: pgTimestamp(in.StartedAt)})
	if err != nil {
		return RunStep{}, fmt.Errorf("starting step %d of run %s: %w", in.Ordinal, in.RunID, wrapQueryErr(err))
	}
	return runStepFromRow(row), nil
}

// CompleteStep persists a completed Step Result before the workflow chooses its next operation.
func (s *Store) CompleteStep(ctx context.Context, runID string, ordinal int, endedAt time.Time, result json.RawMessage) (RunStep, error) {
	id, err := pgUUID(runID)
	if err != nil {
		return RunStep{}, fmt.Errorf("completing step %d: %w", ordinal, err)
	}
	row, err := s.q.CompleteTargetStep(ctx, storedb.CompleteTargetStepParams{RunID: id, Ordinal: int32(ordinal), EndedAt: pgTimestamp(endedAt), Result: result})
	if err != nil {
		return RunStep{}, fmt.Errorf("completing step %d of run %s: %w", ordinal, runID, wrapQueryErr(err))
	}
	return runStepFromRow(row), nil
}

// AgentAttempt is one workflow-authorized agent execution below a target Step.
type AgentAttempt struct {
	RunID             string
	StepOrdinal       int
	AttemptNo         int
	AgentStage        work.AgentStage
	Model             work.Model
	State             work.AgentAttemptState
	FailureKind       work.RunFailureKind
	ProviderThreadID  string
	UsageState        work.UsageState
	Usage             work.Usage
	StartedAt         time.Time
	EndedAt           time.Time
	Result            json.RawMessage
	TranscriptPresent bool
}

// TargetStepDetail is a target Step with its agent executions in numeric order.
type TargetStepDetail struct {
	Step     RunStep
	Attempts []AgentAttempt
}

// TargetRunDetail is the target ordinal projection. Legacy reads remain available
// through RunDetail until the quiesced PR 8 history backfill.
type TargetRunDetail struct {
	Run   Run
	Steps []TargetStepDetail
}

// RunHistory is the compatibility read model while both legacy and target
// writers exist. Legacy rows are projected at read time and are never copied
// into target tables before cutover quiescence.
type RunHistory struct {
	Run    Run
	Steps  []TargetStepDetail
	Legacy bool
}

// History reads target ordinal rows when present and otherwise projects the
// legacy stage/turn history in its existing deterministic order.
func (s *Store) History(ctx context.Context, runID string) (RunHistory, error) {
	target, err := s.TargetRunDetail(ctx, runID)
	if err != nil {
		return RunHistory{}, err
	}
	if len(target.Steps) > 0 {
		return RunHistory{Run: target.Run, Steps: target.Steps}, nil
	}
	legacy, err := s.RunDetail(ctx, runID)
	if err != nil {
		return RunHistory{}, err
	}
	steps := make([]TargetStepDetail, 0, len(legacy.Steps))
	for ordinal, legacyStep := range legacy.Steps {
		step := RunStep{RunID: runID, Ordinal: ordinal + 1, Kind: work.StepKind(legacyStep.Stage), Iteration: legacyStep.Turn, State: work.StepStateCompleted}
		attempts := make([]AgentAttempt, 0, len(legacyStep.Attempts))
		for _, legacyAttempt := range legacyStep.Attempts {
			state := work.AgentAttemptRunning
			switch legacyAttempt.Result {
			case AttemptSucceeded:
				state = work.AgentAttemptSucceeded
			case AttemptFailed:
				state = work.AgentAttemptFailed
			}
			usageState := work.UsageUnknown
			if legacyAttempt.Measured {
				usageState = work.UsageMeasured
			}
			attempts = append(attempts, AgentAttempt{RunID: runID, StepOrdinal: ordinal + 1, AttemptNo: legacyAttempt.AttemptNo, AgentStage: work.AgentStage(legacyAttempt.Key.Stage), Model: legacyAttempt.Model, State: state, UsageState: usageState, Usage: legacyAttempt.Usage, StartedAt: legacyAttempt.StartedAt, EndedAt: legacyAttempt.EndedAt})
		}
		steps = append(steps, TargetStepDetail{Step: step, Attempts: attempts})
	}
	return RunHistory{Run: legacy.Run, Steps: steps, Legacy: true}, nil
}

// TargetRunDetail reads one target Run's complete ordinal history without Temporal.
func (s *Store) TargetRunDetail(ctx context.Context, runID string) (TargetRunDetail, error) {
	id, err := pgUUID(runID)
	if err != nil {
		return TargetRunDetail{}, fmt.Errorf("reading target run detail: %w", err)
	}
	run, err := s.Run(ctx, runID)
	if err != nil {
		return TargetRunDetail{}, err
	}
	steps, err := s.q.TargetStepForRun(ctx, id)
	if err != nil {
		return TargetRunDetail{}, fmt.Errorf("reading target steps: %w", wrapQueryErr(err))
	}
	attempts, err := s.q.TargetAgentAttemptsForRun(ctx, id)
	if err != nil {
		return TargetRunDetail{}, fmt.Errorf("reading target agent attempts: %w", wrapQueryErr(err))
	}
	transcriptKeys, err := s.q.TargetTranscriptKeysForRun(ctx, id)
	if err != nil {
		return TargetRunDetail{}, fmt.Errorf("reading target transcript keys: %w", wrapQueryErr(err))
	}
	present := make(map[[2]int]bool, len(transcriptKeys))
	for _, key := range transcriptKeys {
		present[[2]int{int(key.StepOrdinal), int(key.AttemptNo)}] = true
	}
	byStep := make(map[int][]AgentAttempt, len(steps))
	for _, row := range attempts {
		attempt := agentAttemptFromRow(row)
		attempt.TranscriptPresent = present[[2]int{attempt.StepOrdinal, attempt.AttemptNo}]
		byStep[attempt.StepOrdinal] = append(byStep[attempt.StepOrdinal], attempt)
	}
	detail := TargetRunDetail{Run: run, Steps: make([]TargetStepDetail, 0, len(steps))}
	for _, row := range steps {
		step := runStepFromRow(row)
		detail.Steps = append(detail.Steps, TargetStepDetail{Step: step, Attempts: byStep[step.Ordinal]})
	}
	return detail, nil
}

// StartAgentAttemptInput authorizes one agent execution under a pre-existing Step.
type StartAgentAttemptInput struct {
	RunID       string
	StepOrdinal int
	AttemptNo   int
	AgentStage  work.AgentStage
	Model       work.Model
	UsageState  work.UsageState
	StartedAt   time.Time
}

// StartAgentAttempt persists an agent execution before its transcript can exist.
func (s *Store) StartAgentAttempt(ctx context.Context, in StartAgentAttemptInput) (AgentAttempt, error) {
	id, err := pgUUID(in.RunID)
	if err != nil {
		return AgentAttempt{}, fmt.Errorf("starting agent attempt: %w", err)
	}
	row, err := s.q.StartTargetAgentAttempt(ctx, storedb.StartTargetAgentAttemptParams{RunID: id, StepOrdinal: int32(in.StepOrdinal), AttemptNo: int32(in.AttemptNo), AgentStage: string(in.AgentStage), Model: in.Model.Name, Effort: in.Model.Effort, UsageState: string(in.UsageState), StartedAt: pgTimestamp(in.StartedAt)})
	if err != nil {
		return AgentAttempt{}, fmt.Errorf("starting agent attempt %d of step %d: %w", in.AttemptNo, in.StepOrdinal, wrapQueryErr(err))
	}
	return agentAttemptFromRow(row), nil
}

// AgentCheckpointInput is the terminal durable checkpoint written by a scoped Run Worker capability.
type AgentCheckpointInput struct {
	RunID       string
	StepOrdinal int
	AttemptNo   int
	Capability  string
	ThreadID    string
	State       work.AgentAttemptState
	FailureKind work.RunFailureKind
	UsageState  work.UsageState
	Usage       work.Usage
	EndedAt     time.Time
	Result      json.RawMessage
	Transcript  *TargetTranscript
}

// TargetTranscript is transcript material for one ordinal Agent Attempt.
type TargetTranscript struct {
	CompressedBytes       []byte
	Compression           string
	UncompressedSizeBytes int64
	Checksum              []byte
}

// GitCheckpoint is the durable recovery position for repository-affine work.
type GitCheckpoint struct {
	RunID             string
	StepOrdinal       int
	Branch            string
	PushedHead        string
	ObservedBase      string
	PullRequestNumber int
	PullRequestNodeID string
	StepResult        json.RawMessage
}

// GitCheckpointInput records a GitHub effect before its activity acknowledges success.
type GitCheckpointInput struct {
	GitCheckpoint
	CompletedAt time.Time
}

// CheckpointGitEffect atomically persists the newest Git/PR recovery position
// and completes the corresponding repository-affine Step. It refuses an older
// position rather than allowing replacement recovery to regress a pushed head.
func (s *Store) CheckpointGitEffect(ctx context.Context, in GitCheckpointInput) (GitCheckpoint, error) {
	if s.begin == nil {
		return GitCheckpoint{}, fmt.Errorf("checkpointing git effect: store cannot begin a transaction")
	}
	id, err := pgUUID(in.RunID)
	if err != nil {
		return GitCheckpoint{}, fmt.Errorf("checkpointing git effect: %w", err)
	}
	tx, err := s.begin.Begin(ctx)
	if err != nil {
		return GitCheckpoint{}, fmt.Errorf("checkpointing git effect: beginning transaction: %w", wrapQueryErr(err))
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	previous, previousErr := q.TargetGitCheckpoint(ctx, id)
	if previousErr == nil {
		if previous.StepOrdinal > int32(in.StepOrdinal) || (previous.StepOrdinal == int32(in.StepOrdinal) && (previous.PushedHead != in.PushedHead || previous.PullRequestNumber != int32(in.PullRequestNumber))) {
			return GitCheckpoint{}, fmt.Errorf("checkpointing git effect: older or conflicting checkpoint: %w", work.ErrPermanent)
		}
	} else if !errors.Is(previousErr, pgx.ErrNoRows) {
		return GitCheckpoint{}, fmt.Errorf("checkpointing git effect: reading checkpoint: %w", wrapQueryErr(previousErr))
	}
	row, err := q.PutTargetGitCheckpoint(ctx, storedb.PutTargetGitCheckpointParams{RunID: id, StepOrdinal: int32(in.StepOrdinal), Branch: in.Branch, PushedHead: in.PushedHead, ObservedBase: in.ObservedBase, PullRequestNumber: int32(in.PullRequestNumber), PullRequestNodeID: in.PullRequestNodeID, StepResult: in.StepResult})
	if err != nil {
		return GitCheckpoint{}, fmt.Errorf("checkpointing git effect: writing checkpoint: %w", wrapQueryErr(err))
	}
	if _, err := q.CompleteTargetStep(ctx, storedb.CompleteTargetStepParams{RunID: id, Ordinal: int32(in.StepOrdinal), EndedAt: pgTimestamp(in.CompletedAt), Result: in.StepResult}); err != nil {
		return GitCheckpoint{}, fmt.Errorf("checkpointing git effect: completing step: %w", wrapQueryErr(err))
	}
	if err := tx.Commit(ctx); err != nil {
		return GitCheckpoint{}, fmt.Errorf("checkpointing git effect: committing: %w", wrapQueryErr(err))
	}
	return gitCheckpointFromRow(row), nil
}

// SetCheckpointCapabilityHash stores the one-way capability verifier for a Run.
func (s *Store) SetCheckpointCapabilityHash(ctx context.Context, runID, hash string) error {
	id, err := pgUUID(runID)
	if err != nil {
		return fmt.Errorf("setting checkpoint capability: %w", err)
	}
	if err := s.q.SetRunCheckpointCapabilityHash(ctx, storedb.SetRunCheckpointCapabilityHashParams{ID: id, CheckpointCapabilityHash: pgOptionalText(hash)}); err != nil {
		return fmt.Errorf("setting checkpoint capability for run %s: %w", runID, wrapQueryErr(err))
	}
	return nil
}

// CheckpointAgentAttempt records only the named active Attempt after verifying the Run capability.
func (s *Store) CheckpointAgentAttempt(ctx context.Context, in AgentCheckpointInput) (AgentAttempt, error) {
	if s.begin == nil {
		return AgentAttempt{}, fmt.Errorf("checkpointing agent attempt: store cannot begin a transaction")
	}
	id, err := pgUUID(in.RunID)
	if err != nil {
		return AgentAttempt{}, fmt.Errorf("checkpointing agent attempt: %w", err)
	}
	tx, err := s.begin.Begin(ctx)
	if err != nil {
		return AgentAttempt{}, fmt.Errorf("checkpointing agent attempt: beginning transaction: %w", wrapQueryErr(err))
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	run, err := q.TargetRunForUpdate(ctx, id)
	if err != nil {
		return AgentAttempt{}, fmt.Errorf("checkpointing agent attempt: reading run: %w", wrapQueryErr(err))
	}
	if !run.CheckpointCapabilityHash.Valid || run.CheckpointCapabilityHash.String != capabilityHash(in.Capability) {
		return AgentAttempt{}, fmt.Errorf("checkpointing agent attempt: %w", ErrRunOwnership)
	}
	ticket, err := q.TargetTicketForUpdate(ctx, run.TicketID)
	if err != nil {
		return AgentAttempt{}, fmt.Errorf("checkpointing agent attempt: reading ticket: %w", wrapQueryErr(err))
	}
	if ticket.State != TicketActive.String() || runIDString(ticket.ActiveRunID) != in.RunID {
		return AgentAttempt{}, fmt.Errorf("checkpointing agent attempt: %w", ErrRunOwnership)
	}
	current, err := q.TargetAgentAttemptForUpdate(ctx, storedb.TargetAgentAttemptForUpdateParams{
		RunID: id, StepOrdinal: int32(in.StepOrdinal), AttemptNo: int32(in.AttemptNo),
	})
	if err != nil {
		return AgentAttempt{}, fmt.Errorf("checkpointing agent attempt: reading attempt: %w", wrapQueryErr(err))
	}
	if current.State != string(work.AgentAttemptRunning) {
		if current.State != string(in.State) || current.ProviderThreadID != in.ThreadID ||
			current.UsageState != string(in.UsageState) || string(current.Result) != string(in.Result) {
			return AgentAttempt{}, fmt.Errorf("checkpointing agent attempt: conflicting terminal checkpoint: %w", work.ErrPermanent)
		}
		if err := tx.Commit(ctx); err != nil {
			return AgentAttempt{}, fmt.Errorf("checkpointing agent attempt: committing retry: %w", wrapQueryErr(err))
		}
		return agentAttemptFromRow(current), nil
	}
	row, err := q.CheckpointTargetAgentAttempt(ctx, storedb.CheckpointTargetAgentAttemptParams{RunID: id, StepOrdinal: int32(in.StepOrdinal), AttemptNo: int32(in.AttemptNo), ProviderThreadID: in.ThreadID, State: string(in.State), FailureKind: string(in.FailureKind), UsageState: string(in.UsageState), InputTokens: in.Usage.InputTokens, CachedInputTokens: in.Usage.CachedInputTokens, OutputTokens: in.Usage.OutputTokens, ReasoningTokens: in.Usage.ReasoningTokens, EndedAt: pgTimestamp(in.EndedAt), Result: in.Result})
	if err != nil {
		return AgentAttempt{}, fmt.Errorf("checkpointing agent attempt %d: %w", in.AttemptNo, wrapQueryErr(err))
	}
	if in.Transcript != nil {
		err = q.PutTargetAgentTranscript(ctx, storedb.PutTargetAgentTranscriptParams{RunID: id, StepOrdinal: int32(in.StepOrdinal), AttemptNo: int32(in.AttemptNo), CompressedBytes: in.Transcript.CompressedBytes, Compression: in.Transcript.Compression, UncompressedSizeBytes: in.Transcript.UncompressedSizeBytes, Checksum: in.Transcript.Checksum})
		if err != nil {
			return AgentAttempt{}, fmt.Errorf("checkpointing transcript: %w", wrapQueryErr(err))
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return AgentAttempt{}, fmt.Errorf("checkpointing agent attempt: committing: %w", wrapQueryErr(err))
	}
	return agentAttemptFromRow(row), nil
}

// ConfirmedMergeInput names the immutable merge evidence and its Merge Step.
type ConfirmedMergeInput struct {
	RunID        string
	TicketID     TicketID
	StepOrdinal  int
	ReviewedHead string
	MergeSHA     string
	EndedAt      time.Time
}

// TerminalResult is the durable outcome of terminal recording.
type TerminalResult struct {
	Ticket Ticket
	Run    Run
}

// FinalizeConfirmedMerge atomically completes the Merge Step, records immutable merge evidence,
// closes the Run, and releases dependency readiness by moving only its owned Ticket to done.
func (s *Store) FinalizeConfirmedMerge(ctx context.Context, in ConfirmedMergeInput) (TerminalResult, error) {
	if s.begin == nil {
		return TerminalResult{}, fmt.Errorf("finalizing merge: store cannot begin a transaction")
	}
	id, err := pgUUID(in.RunID)
	if err != nil {
		return TerminalResult{}, fmt.Errorf("finalizing merge: %w", err)
	}
	tx, err := s.begin.Begin(ctx)
	if err != nil {
		return TerminalResult{}, fmt.Errorf("finalizing merge: beginning transaction: %w", wrapQueryErr(err))
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	runRow, err := q.TargetRunForUpdate(ctx, id)
	if err != nil {
		return TerminalResult{}, fmt.Errorf("finalizing merge: reading run: %w", wrapQueryErr(err))
	}
	if runRow.TicketID != int64(in.TicketID) {
		return TerminalResult{}, fmt.Errorf("finalizing merge: %w", ErrRunOwnership)
	}
	if runRow.TargetOutcome.Valid {
		if runRow.TargetOutcome.String != string(work.RunOutcomeSucceeded) || textFromPg(runRow.MergeSha) != in.MergeSHA || textFromPg(runRow.ReviewedHead) != in.ReviewedHead {
			return TerminalResult{}, fmt.Errorf("finalizing merge: conflicting terminal result: %w", work.ErrPermanent)
		}
		ticketRow, ticketErr := q.TargetTicketForUpdate(ctx, int64(in.TicketID))
		if ticketErr != nil {
			return TerminalResult{}, fmt.Errorf("finalizing merge retry: reading ticket: %w", wrapQueryErr(ticketErr))
		}
		ticket, parseErr := ticketFromRow(ticketRow)
		if parseErr != nil {
			return TerminalResult{}, parseErr
		}
		if err := tx.Commit(ctx); err != nil {
			return TerminalResult{}, fmt.Errorf("finalizing merge retry: committing: %w", wrapQueryErr(err))
		}
		return TerminalResult{Ticket: ticket, Run: runFromRow(runRow)}, nil
	}
	if _, err := q.CompleteTargetStep(ctx, storedb.CompleteTargetStepParams{RunID: id, Ordinal: int32(in.StepOrdinal), EndedAt: pgTimestamp(in.EndedAt), Result: []byte(`{"kind":"merged","merge_sha":"` + in.MergeSHA + `"}`)}); err != nil {
		return TerminalResult{}, fmt.Errorf("finalizing merge: completing step: %w", wrapQueryErr(err))
	}
	completedRun, err := q.CompleteTargetRunSuccess(ctx, storedb.CompleteTargetRunSuccessParams{ID: id, ReviewedHead: pgOptionalText(in.ReviewedHead), MergeSha: pgOptionalText(in.MergeSHA), EndedAt: pgTimestamp(in.EndedAt)})
	if err != nil {
		return TerminalResult{}, fmt.Errorf("finalizing merge: completing run: %w", wrapQueryErr(err))
	}
	ticketRow, err := q.CompleteTargetTicket(ctx, storedb.CompleteTargetTicketParams{ID: int64(in.TicketID), ActiveRunID: id})
	if err != nil {
		return TerminalResult{}, fmt.Errorf("finalizing merge: completing ticket: %w", ErrRunOwnership)
	}
	ticket, err := ticketFromRow(ticketRow)
	if err != nil {
		return TerminalResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return TerminalResult{}, fmt.Errorf("finalizing merge: committing: %w", wrapQueryErr(err))
	}
	return TerminalResult{Ticket: ticket, Run: runFromRow(completedRun)}, nil
}

// CancelRunInput names one conditional cancellation finalization.
type CancelRunInput struct {
	RunID    string
	TicketID TicketID
	EndedAt  time.Time
}

// ReconcileAbandonedRun conditionally releases an active Ticket after direct
// workflow termination. It deliberately leaves the Run nonterminal: a
// maintainer observed abandoned ownership, not a normal cancellation result.
func (s *Store) ReconcileAbandonedRun(ctx context.Context, runID string, ticketID TicketID) (bool, error) {
	if s.begin == nil {
		return false, fmt.Errorf("reconciling abandoned run: store cannot begin a transaction")
	}
	id, err := pgUUID(runID)
	if err != nil {
		return false, fmt.Errorf("reconciling abandoned run: %w", err)
	}
	tx, err := s.begin.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("reconciling abandoned run: beginning transaction: %w", wrapQueryErr(err))
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	run, err := q.TargetRunForUpdate(ctx, id)
	if err != nil {
		return false, fmt.Errorf("reconciling abandoned run: reading run: %w", wrapQueryErr(err))
	}
	if run.TicketID != int64(ticketID) || run.TargetOutcome.Valid {
		if err := tx.Commit(ctx); err != nil {
			return false, fmt.Errorf("reconciling abandoned run: committing no-op: %w", wrapQueryErr(err))
		}
		return false, nil
	}
	_, err = q.ReopenTargetTicket(ctx, storedb.ReopenTargetTicketParams{ID: int64(ticketID), ActiveRunID: id})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, fmt.Errorf("reconciling abandoned run: reopening ticket: %w", wrapQueryErr(err))
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("reconciling abandoned run: committing: %w", wrapQueryErr(err))
	}
	return err == nil, nil
}

// CancelRun closes an unmerged Run and reopens only the Ticket it still owns.
func (s *Store) CancelRun(ctx context.Context, in CancelRunInput) (TerminalResult, error) {
	if s.begin == nil {
		return TerminalResult{}, fmt.Errorf("canceling run: store cannot begin a transaction")
	}
	id, err := pgUUID(in.RunID)
	if err != nil {
		return TerminalResult{}, fmt.Errorf("canceling run: %w", err)
	}
	tx, err := s.begin.Begin(ctx)
	if err != nil {
		return TerminalResult{}, fmt.Errorf("canceling run: beginning transaction: %w", wrapQueryErr(err))
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	runRow, err := q.TargetRunForUpdate(ctx, id)
	if err != nil {
		return TerminalResult{}, fmt.Errorf("canceling run: reading run: %w", wrapQueryErr(err))
	}
	if runRow.TicketID != int64(in.TicketID) {
		return TerminalResult{}, fmt.Errorf("canceling run: %w", ErrRunOwnership)
	}
	if runRow.TargetOutcome.Valid && runRow.TargetOutcome.String != string(work.RunOutcomeCanceled) {
		ticketRow, ticketErr := q.TargetTicketForUpdate(ctx, int64(in.TicketID))
		if ticketErr != nil {
			return TerminalResult{}, fmt.Errorf("canceling completed run: reading ticket: %w", wrapQueryErr(ticketErr))
		}
		ticket, parseErr := ticketFromRow(ticketRow)
		if parseErr != nil {
			return TerminalResult{}, parseErr
		}
		if err := tx.Commit(ctx); err != nil {
			return TerminalResult{}, fmt.Errorf("canceling completed run: committing: %w", wrapQueryErr(err))
		}
		return TerminalResult{Ticket: ticket, Run: runFromRow(runRow)}, nil
	}
	if !runRow.TargetOutcome.Valid {
		runRow, err = q.CompleteTargetRunCanceled(ctx, storedb.CompleteTargetRunCanceledParams{ID: id, EndedAt: pgTimestamp(in.EndedAt)})
		if err != nil {
			return TerminalResult{}, fmt.Errorf("canceling run: completing: %w", wrapQueryErr(err))
		}
	}
	ticketRow, err := q.ReopenTargetTicket(ctx, storedb.ReopenTargetTicketParams{ID: int64(in.TicketID), ActiveRunID: id})
	if err != nil {
		// A retry after the ticket was reopened is still a successful canceled outcome.
		ticketRow, err = q.TargetTicketForUpdate(ctx, int64(in.TicketID))
		if err != nil {
			return TerminalResult{}, fmt.Errorf("canceling run: reading ticket: %w", wrapQueryErr(err))
		}
	}
	ticket, err := ticketFromRow(ticketRow)
	if err != nil {
		return TerminalResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return TerminalResult{}, fmt.Errorf("canceling run: committing: %w", wrapQueryErr(err))
	}
	return TerminalResult{Ticket: ticket, Run: runFromRow(runRow)}, nil
}

func capabilityHash(capability string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(capability)))
}

func runStepFromRow(row storedb.RunStep) RunStep {
	return RunStep{RunID: runIDString(row.RunID), Ordinal: int(row.Ordinal), Kind: work.StepKind(row.Kind), Iteration: int(row.Iteration), Reason: row.Reason, State: work.StepState(row.State), StartedAt: timeFromPg(row.StartedAt), EndedAt: timeFromPg(row.EndedAt), Result: row.Result}
}

func agentAttemptFromRow(row storedb.RunAgentAttempt) AgentAttempt {
	return AgentAttempt{RunID: runIDString(row.RunID), StepOrdinal: int(row.StepOrdinal), AttemptNo: int(row.AttemptNo), AgentStage: work.AgentStage(row.AgentStage), Model: work.Model{Name: row.Model, Effort: row.Effort}, State: work.AgentAttemptState(row.State), FailureKind: work.RunFailureKind(row.FailureKind), ProviderThreadID: row.ProviderThreadID, UsageState: work.UsageState(row.UsageState), Usage: work.Usage{InputTokens: row.InputTokens, CachedInputTokens: row.CachedInputTokens, OutputTokens: row.OutputTokens, ReasoningTokens: row.ReasoningTokens}, StartedAt: timeFromPg(row.StartedAt), EndedAt: timeFromPg(row.EndedAt), Result: row.Result}
}

func gitCheckpointFromRow(row storedb.RunGitCheckpoint) GitCheckpoint {
	return GitCheckpoint{RunID: runIDString(row.RunID), StepOrdinal: int(row.StepOrdinal), Branch: row.Branch, PushedHead: row.PushedHead, ObservedBase: row.ObservedBase, PullRequestNumber: int(row.PullRequestNumber), PullRequestNodeID: row.PullRequestNodeID, StepResult: row.StepResult}
}

// CheckpointCapabilityHash hashes capability without retaining the secret at call sites.
func CheckpointCapabilityHash(capability string) string { return capabilityHash(capability) }

var (
	_ TargetRunClaimer       = (*Store)(nil)
	_ TargetStepRecorder     = (*Store)(nil)
	_ TargetAgentRecorder    = (*Store)(nil)
	_ TargetTerminalRecorder = (*Store)(nil)
)
