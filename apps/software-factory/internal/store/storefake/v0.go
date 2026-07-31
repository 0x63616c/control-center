package storefake

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// ClaimAndStartRun mirrors the target Store's atomic ownership boundary.
func (f *Store) ClaimAndStartRun(_ context.Context, in store.ClaimRunInput) (store.ClaimRunResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ticket, ok := f.tickets[in.TicketID]
	if !ok {
		return store.ClaimRunResult{}, fmt.Errorf("ticket %d: %w", in.TicketID, store.ErrNotFound)
	}
	if ticket.State == store.TicketActive {
		if ticket.ActiveRunID != in.RunID {
			return store.ClaimRunResult{}, fmt.Errorf("ticket %d: %w", in.TicketID, store.ErrTicketClaimed)
		}
		return store.ClaimRunResult{Ticket: ticket, Run: f.runs[in.RunID]}, nil
	}
	if ticket.State != store.TicketOpen {
		return store.ClaimRunResult{}, fmt.Errorf("ticket %d: %w", in.TicketID, store.ErrTicketClaimed)
	}
	ticket.State, ticket.ActiveRunID, ticket.UpdatedAt = store.TicketActive, in.RunID, f.clk.Now()
	f.tickets[in.TicketID] = ticket
	run := store.Run{ID: in.RunID, TicketID: in.TicketID, StartedAt: in.StartedAt}
	f.runs[in.RunID] = run
	return store.ClaimRunResult{Ticket: ticket, Run: run}, nil
}

// StartStep records an ordinal target Step exactly once.
func (f *Store) StartStep(_ context.Context, in store.StartStepInput) (store.RunStep, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	k := targetStepKey{runID: in.RunID, ordinal: in.Ordinal}
	if step, ok := f.targetSteps[k]; ok {
		return step, nil
	}
	step := store.RunStep{RunID: in.RunID, Ordinal: in.Ordinal, Kind: in.Kind, Iteration: in.Iteration, Reason: in.Reason, State: work.StepStateRunning, StartedAt: in.StartedAt}
	f.targetSteps[k] = step
	return step, nil
}

// CompleteStep completes a target Step with its durable result.
func (f *Store) CompleteStep(_ context.Context, runID string, ordinal int, endedAt time.Time, result json.RawMessage) (store.RunStep, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	k := targetStepKey{runID: runID, ordinal: ordinal}
	step, ok := f.targetSteps[k]
	if !ok {
		return store.RunStep{}, fmt.Errorf("step %d: %w", ordinal, store.ErrNotFound)
	}
	step.State, step.EndedAt, step.Result = work.StepStateCompleted, endedAt, result
	f.targetSteps[k] = step
	return step, nil
}

// StartAgentAttempt records one agent execution under an existing target Step.
func (f *Store) StartAgentAttempt(_ context.Context, in store.StartAgentAttemptInput) (store.AgentAttempt, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.targetSteps[targetStepKey{runID: in.RunID, ordinal: in.StepOrdinal}]; !ok {
		return store.AgentAttempt{}, fmt.Errorf("step %d: %w", in.StepOrdinal, store.ErrNotFound)
	}
	k := targetAttemptKey{targetStepKey: targetStepKey{runID: in.RunID, ordinal: in.StepOrdinal}, attemptNo: in.AttemptNo}
	if attempt, ok := f.targetAttempts[k]; ok {
		return attempt, nil
	}
	attempt := store.AgentAttempt{RunID: in.RunID, StepOrdinal: in.StepOrdinal, AttemptNo: in.AttemptNo, AgentStage: in.AgentStage, Model: in.Model, State: work.AgentAttemptRunning, UsageState: in.UsageState, StartedAt: in.StartedAt}
	f.targetAttempts[k] = attempt
	return attempt, nil
}

// SetCheckpointCapabilityHash stores the scoped capability verifier.
func (f *Store) SetCheckpointCapabilityHash(_ context.Context, runID, hash string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.capabilityHash[runID] = hash
	return nil
}

// CheckpointAgentAttempt writes only an Attempt owned by the supplied capability.
func (f *Store) CheckpointAgentAttempt(_ context.Context, in store.AgentCheckpointInput) (store.AgentAttempt, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.capabilityHash[in.RunID] != store.CheckpointCapabilityHash(in.Capability) {
		return store.AgentAttempt{}, fmt.Errorf("checkpoint: %w", store.ErrRunOwnership)
	}
	k := targetAttemptKey{targetStepKey: targetStepKey{runID: in.RunID, ordinal: in.StepOrdinal}, attemptNo: in.AttemptNo}
	attempt, ok := f.targetAttempts[k]
	if !ok {
		return store.AgentAttempt{}, fmt.Errorf("attempt %d: %w", in.AttemptNo, store.ErrNotFound)
	}
	attempt.ProviderThreadID, attempt.State, attempt.FailureKind, attempt.UsageState, attempt.Usage, attempt.EndedAt, attempt.Result = in.ThreadID, in.State, in.FailureKind, in.UsageState, in.Usage, in.EndedAt, in.Result
	f.targetAttempts[k] = attempt
	return attempt, nil
}

// CheckpointGitEffect stores a monotonic repository recovery checkpoint.
func (f *Store) CheckpointGitEffect(_ context.Context, in store.GitCheckpointInput) (store.GitCheckpoint, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if previous, ok := f.targetGit[in.RunID]; ok && (previous.StepOrdinal > in.StepOrdinal || (previous.StepOrdinal == in.StepOrdinal && previous.PushedHead != in.PushedHead)) {
		return store.GitCheckpoint{}, fmt.Errorf("checkpoint: %w", work.ErrPermanent)
	}
	f.targetGit[in.RunID] = in.GitCheckpoint
	k := targetStepKey{runID: in.RunID, ordinal: in.StepOrdinal}
	if step, ok := f.targetSteps[k]; ok {
		step.State, step.EndedAt, step.Result = work.StepStateCompleted, in.CompletedAt, in.StepResult
		f.targetSteps[k] = step
	}
	return in.GitCheckpoint, nil
}

// FinalizeConfirmedMerge commits the irreversible target terminal outcome.
func (f *Store) FinalizeConfirmedMerge(_ context.Context, in store.ConfirmedMergeInput) (store.TerminalResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	run, ok := f.runs[in.RunID]
	if !ok || run.TicketID != in.TicketID {
		return store.TerminalResult{}, fmt.Errorf("merge: %w", store.ErrRunOwnership)
	}
	if run.TargetOutcome != "" {
		if run.TargetOutcome != work.RunOutcomeSucceeded || run.MergeSHA != in.MergeSHA {
			return store.TerminalResult{}, fmt.Errorf("merge: %w", work.ErrPermanent)
		}
		return store.TerminalResult{Ticket: f.tickets[in.TicketID], Run: run}, nil
	}
	ticket := f.tickets[in.TicketID]
	if ticket.State != store.TicketActive || ticket.ActiveRunID != in.RunID {
		return store.TerminalResult{}, fmt.Errorf("merge: %w", store.ErrRunOwnership)
	}
	run.TargetOutcome, run.ReviewedHead, run.MergeSHA, run.EndedAt = work.RunOutcomeSucceeded, in.ReviewedHead, in.MergeSHA, in.EndedAt
	ticket.State, ticket.ActiveRunID, ticket.UpdatedAt = store.TicketDone, "", f.clk.Now()
	f.runs[in.RunID], f.tickets[in.TicketID] = run, ticket
	return store.TerminalResult{Ticket: ticket, Run: run}, nil
}

// CancelRun conditionally returns an unmerged owned Ticket to open.
func (f *Store) CancelRun(_ context.Context, in store.CancelRunInput) (store.TerminalResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	run, ok := f.runs[in.RunID]
	if !ok || run.TicketID != in.TicketID {
		return store.TerminalResult{}, fmt.Errorf("cancel: %w", store.ErrRunOwnership)
	}
	ticket := f.tickets[in.TicketID]
	if run.TargetOutcome == "" {
		run.TargetOutcome, run.EndedAt = work.RunOutcomeCanceled, in.EndedAt
		if ticket.State == store.TicketActive && ticket.ActiveRunID == in.RunID {
			ticket.State, ticket.ActiveRunID, ticket.UpdatedAt = store.TicketOpen, "", f.clk.Now()
			f.tickets[in.TicketID] = ticket
		}
		f.runs[in.RunID] = run
	}
	return store.TerminalResult{Ticket: f.tickets[in.TicketID], Run: f.runs[in.RunID]}, nil
}

// ReconcileAbandonedRun releases only nonterminal ownership without inventing an outcome.
func (f *Store) ReconcileAbandonedRun(_ context.Context, runID string, ticketID store.TicketID) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	run, ok := f.runs[runID]
	if !ok || run.TicketID != ticketID || run.TargetOutcome != "" {
		return false, nil
	}
	ticket := f.tickets[ticketID]
	if ticket.State != store.TicketActive || ticket.ActiveRunID != runID {
		return false, nil
	}
	ticket.State, ticket.ActiveRunID, ticket.UpdatedAt = store.TicketOpen, "", f.clk.Now()
	f.tickets[ticketID] = ticket
	return true, nil
}

var (
	_ store.TargetRunClaimer       = (*Store)(nil)
	_ store.TargetStepRecorder     = (*Store)(nil)
	_ store.TargetAgentRecorder    = (*Store)(nil)
	_ store.TargetTerminalRecorder = (*Store)(nil)
)
