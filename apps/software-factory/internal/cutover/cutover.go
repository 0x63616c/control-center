// Package cutover owns the one-time, inert-until-invoked migration gate from
// the legacy factory workflows to the target Run/Step/Attempt system.
package cutover

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"
)

// Mode controls whether Execute only observes, plans, or mutates.
type Mode string

const (
	// ModeInventory observes the complete legacy boundary without mutation.
	ModeInventory Mode = "inventory"
	// ModeDryRun emits the actions apply would take without performing them.
	ModeDryRun Mode = "dry-run"
	// ModeApply performs the explicit quiesce and repair sequence.
	ModeApply Mode = "apply"
)

// WorkflowKind distinguishes the singleton dispatcher from per-Ticket Runs.
type WorkflowKind string

const (
	// WorkflowDispatcher identifies the pre-redesign singleton dispatcher.
	WorkflowDispatcher WorkflowKind = "dispatcher"
	// WorkflowTicket identifies one pre-redesign per-ticket execution.
	WorkflowTicket WorkflowKind = "ticket"
)

// WorkflowExecution is one still-open pre-redesign Temporal execution.
type WorkflowExecution struct {
	ID     string       `json:"id"`
	RunID  string       `json:"runId"`
	Kind   WorkflowKind `json:"kind"`
	Type   string       `json:"type"`
	Status string       `json:"status"`
}

// PullRequest is an unmerged PR owned by a pre-redesign factory branch.
type PullRequest struct {
	Number           int    `json:"number"`
	NodeID           string `json:"nodeId"`
	Branch           string `json:"branch"`
	URL              string `json:"url"`
	AutoMergeEnabled bool   `json:"autoMergeEnabled"`
}

// LegacyTicket is a Ticket still in the old working/review vocabulary.
type LegacyTicket struct {
	ID      int64  `json:"id"`
	State   string `json:"state"`
	Version string `json:"version"`
}

// Inventory is the complete cutover safety view at one instant.
type Inventory struct {
	Workflows    []WorkflowExecution `json:"workflows"`
	PullRequests []PullRequest       `json:"pullRequests"`
	Tickets      []LegacyTicket      `json:"tickets"`
}

// Action records one planned or applied operation without carrying credentials.
type Action struct {
	Kind   string `json:"kind"`
	Target string `json:"target"`
	Status string `json:"status"`
}

// Report is the stable JSON artifact retained for the PR 8 operational gate.
type Report struct {
	Version int       `json:"version"`
	Mode    Mode      `json:"mode"`
	Ready   bool      `json:"ready"`
	Before  Inventory `json:"before"`
	After   Inventory `json:"after"`
	Actions []Action  `json:"actions"`
}

// Options bounds cooperative cancellation before forced termination.
type Options struct {
	Mode        Mode
	GracePeriod time.Duration
}

// ErrNotReady identifies a completed gate whose final inventory still blocks
// target activation. Callers can distinguish that operational refusal from an
// unavailable dependency while retaining the complete report.
var ErrNotReady = errors.New("software factory cutover is not ready")

// NotReadyError carries the exact report that made an apply refuse activation.
type NotReadyError struct {
	Report Report
}

func (err *NotReadyError) Error() string { return ErrNotReady.Error() }
func (err *NotReadyError) Unwrap() error { return ErrNotReady }

// Temporal is the exact legacy-execution control surface the gate needs.
type Temporal interface {
	ListLegacyExecutions(context.Context) ([]WorkflowExecution, error)
	PauseLegacyDispatcher(context.Context) error
	CancelLegacyExecution(context.Context, WorkflowExecution) error
	AwaitLegacyExecutionClosed(context.Context, WorkflowExecution, time.Duration) (bool, error)
	TerminateLegacyExecution(context.Context, WorkflowExecution) error
	TerminateLegacyDispatcher(context.Context, WorkflowExecution) error
}

// GitHub is the exact old-PR merge-authorization surface the gate needs.
type GitHub interface {
	ListLegacyPullRequests(context.Context) ([]PullRequest, error)
	DisableAutoMerge(context.Context, PullRequest) error
}

// Tickets owns the single transactional legacy-state repair.
type Tickets interface {
	ListLegacyTickets(context.Context) ([]LegacyTicket, error)
	ReopenLegacyTickets(context.Context, []LegacyTicket) ([]LegacyTicket, error)
}

// Dependencies groups the three independently fakeable external boundaries.
type Dependencies struct {
	Temporal Temporal
	GitHub   GitHub
	Tickets  Tickets
}

// Execute inventories or applies the idempotent quiesce/reconcile sequence.
func Execute(ctx context.Context, dependencies Dependencies, options Options) (Report, error) {
	report := Report{Version: 1, Mode: options.Mode, Actions: []Action{}}
	if options.Mode != ModeInventory && options.Mode != ModeDryRun && options.Mode != ModeApply {
		return report, fmt.Errorf("cutover mode %q is invalid", options.Mode)
	}
	if dependencies.Temporal == nil || dependencies.GitHub == nil || dependencies.Tickets == nil {
		return report, fmt.Errorf("cutover dependencies are incomplete")
	}
	if options.GracePeriod < 0 {
		return report, fmt.Errorf("cutover grace period cannot be negative")
	}

	before, err := inventory(ctx, dependencies)
	if err != nil {
		return report, err
	}
	report.Before = before
	report.After = before
	report.Ready = ready(before)
	if options.Mode == ModeInventory || report.Ready {
		return report, nil
	}
	if options.Mode == ModeDryRun {
		report.Actions = plannedActions(before)
		return report, nil
	}

	dispatchers, _ := splitExecutions(before.Workflows)
	if len(dispatchers) > 0 {
		if err := dependencies.Temporal.PauseLegacyDispatcher(ctx); err != nil {
			return report, fmt.Errorf("pausing legacy dispatcher: %w", err)
		}
		report.Actions = append(report.Actions, Action{Kind: "pause_dispatcher", Target: dispatchers[0].ID, Status: "applied"})
	}

	// Re-inventory after Temporal accepted the pause signal. Anything admitted
	// in the initial inventory/pause race is included in this run; anything
	// admitted later is caught by the closure inventory before ticket repair.
	quiesced, err := inventory(ctx, dependencies)
	if err != nil {
		return report, fmt.Errorf("inventorying after dispatcher pause: %w", err)
	}
	dispatchers, tickets := splitExecutions(quiesced.Workflows)
	for _, pullRequest := range quiesced.PullRequests {
		if !pullRequest.AutoMergeEnabled {
			continue
		}
		if err := dependencies.GitHub.DisableAutoMerge(ctx, pullRequest); err != nil {
			return report, fmt.Errorf("disabling auto-merge on pull request %d: %w", pullRequest.Number, err)
		}
		report.Actions = append(report.Actions, Action{Kind: "disable_auto_merge", Target: fmt.Sprintf("pull_request/%d", pullRequest.Number), Status: "applied"})
	}
	for _, execution := range tickets {
		if err := dependencies.Temporal.CancelLegacyExecution(ctx, execution); err != nil {
			return report, fmt.Errorf("canceling legacy execution %s/%s: %w", execution.ID, execution.RunID, err)
		}
		report.Actions = append(report.Actions, Action{Kind: "cancel_workflow", Target: executionTarget(execution), Status: "applied"})
	}
	for _, execution := range tickets {
		closed, err := dependencies.Temporal.AwaitLegacyExecutionClosed(ctx, execution, options.GracePeriod)
		if err != nil {
			return report, fmt.Errorf("waiting for legacy execution %s/%s: %w", execution.ID, execution.RunID, err)
		}
		if closed {
			continue
		}
		if err := dependencies.Temporal.TerminateLegacyExecution(ctx, execution); err != nil {
			return report, fmt.Errorf("terminating legacy execution %s/%s: %w", execution.ID, execution.RunID, err)
		}
		report.Actions = append(report.Actions, Action{Kind: "terminate_workflow", Target: executionTarget(execution), Status: "applied"})
		if _, err := dependencies.Temporal.AwaitLegacyExecutionClosed(ctx, execution, options.GracePeriod); err != nil {
			return report, fmt.Errorf("proving terminated legacy execution %s/%s closed: %w", execution.ID, execution.RunID, err)
		}
	}
	for _, dispatcher := range dispatchers {
		if err := dependencies.Temporal.TerminateLegacyDispatcher(ctx, dispatcher); err != nil {
			return report, fmt.Errorf("terminating legacy dispatcher %s/%s: %w", dispatcher.ID, dispatcher.RunID, err)
		}
		report.Actions = append(report.Actions, Action{Kind: "terminate_dispatcher", Target: executionTarget(dispatcher), Status: "applied"})
		if _, err := dependencies.Temporal.AwaitLegacyExecutionClosed(ctx, dispatcher, options.GracePeriod); err != nil {
			return report, fmt.Errorf("proving terminated legacy dispatcher %s/%s closed: %w", dispatcher.ID, dispatcher.RunID, err)
		}
	}

	closedInventory, err := inventory(ctx, dependencies)
	if err != nil {
		return report, fmt.Errorf("verifying legacy workflows closed: %w", err)
	}
	report.After = closedInventory
	if len(closedInventory.Workflows) > 0 {
		return report, &NotReadyError{Report: report}
	}
	if len(quiesced.Tickets) > 0 {
		reopened, err := dependencies.Tickets.ReopenLegacyTickets(ctx, quiesced.Tickets)
		if err != nil {
			return report, fmt.Errorf("reopening legacy tickets: %w", err)
		}
		for _, ticket := range reopened {
			report.Actions = append(report.Actions, Action{Kind: "reopen_ticket", Target: fmt.Sprintf("ticket/%d", ticket.ID), Status: "applied"})
		}
	}

	after, err := inventory(ctx, dependencies)
	if err != nil {
		return report, fmt.Errorf("verifying cutover: %w", err)
	}
	report.After = after
	report.Ready = ready(after)
	if !report.Ready {
		return report, &NotReadyError{Report: report}
	}
	return report, nil
}

func inventory(ctx context.Context, dependencies Dependencies) (Inventory, error) {
	workflows, err := dependencies.Temporal.ListLegacyExecutions(ctx)
	if err != nil {
		return Inventory{}, fmt.Errorf("listing legacy workflows: %w", err)
	}
	pullRequests, err := dependencies.GitHub.ListLegacyPullRequests(ctx)
	if err != nil {
		return Inventory{}, fmt.Errorf("listing legacy pull requests: %w", err)
	}
	tickets, err := dependencies.Tickets.ListLegacyTickets(ctx)
	if err != nil {
		return Inventory{}, fmt.Errorf("listing legacy tickets: %w", err)
	}
	for _, execution := range workflows {
		if execution.Kind != WorkflowDispatcher && execution.Kind != WorkflowTicket {
			return Inventory{}, fmt.Errorf("legacy workflow %s/%s has unknown kind %q", execution.ID, execution.RunID, execution.Kind)
		}
	}
	sort.Slice(workflows, func(left, right int) bool {
		if workflows[left].Kind != workflows[right].Kind {
			return workflows[left].Kind < workflows[right].Kind
		}
		if workflows[left].ID != workflows[right].ID {
			return workflows[left].ID < workflows[right].ID
		}
		return workflows[left].RunID < workflows[right].RunID
	})
	sort.Slice(pullRequests, func(left, right int) bool { return pullRequests[left].Number < pullRequests[right].Number })
	sort.Slice(tickets, func(left, right int) bool { return tickets[left].ID < tickets[right].ID })
	return Inventory{Workflows: nonNil(workflows), PullRequests: nonNil(pullRequests), Tickets: nonNil(tickets)}, nil
}

func ready(inventory Inventory) bool {
	if len(inventory.Workflows) > 0 || len(inventory.Tickets) > 0 {
		return false
	}
	for _, pullRequest := range inventory.PullRequests {
		if pullRequest.AutoMergeEnabled {
			return false
		}
	}
	return true
}

func splitExecutions(executions []WorkflowExecution) (dispatchers, tickets []WorkflowExecution) {
	for _, execution := range executions {
		switch execution.Kind {
		case WorkflowDispatcher:
			dispatchers = append(dispatchers, execution)
		case WorkflowTicket:
			tickets = append(tickets, execution)
		}
	}
	return dispatchers, tickets
}

func plannedActions(inventory Inventory) []Action {
	var actions []Action
	dispatchers, tickets := splitExecutions(inventory.Workflows)
	if len(dispatchers) > 0 {
		actions = append(actions, Action{Kind: "pause_dispatcher", Target: dispatchers[0].ID, Status: "planned"})
	}
	for _, pullRequest := range inventory.PullRequests {
		if pullRequest.AutoMergeEnabled {
			actions = append(actions, Action{Kind: "disable_auto_merge", Target: fmt.Sprintf("pull_request/%d", pullRequest.Number), Status: "planned"})
		}
	}
	for _, execution := range tickets {
		actions = append(actions, Action{Kind: "cancel_then_terminate_workflow", Target: executionTarget(execution), Status: "planned"})
	}
	for _, dispatcher := range dispatchers {
		actions = append(actions, Action{Kind: "terminate_dispatcher", Target: executionTarget(dispatcher), Status: "planned"})
	}
	for _, ticket := range inventory.Tickets {
		actions = append(actions, Action{Kind: "reopen_ticket", Target: fmt.Sprintf("ticket/%d", ticket.ID), Status: "planned"})
	}
	return nonNil(actions)
}

func executionTarget(execution WorkflowExecution) string {
	return execution.ID + "/" + execution.RunID
}

func nonNil[T any](values []T) []T {
	if values == nil {
		return []T{}
	}
	return values
}
