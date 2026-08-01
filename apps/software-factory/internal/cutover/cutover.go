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

// WorkflowKind distinguishes the singleton dispatcher, per-Ticket workflows,
// and their pre-activation agent children.
type WorkflowKind string

const (
	// WorkflowDispatcher identifies the pre-redesign singleton dispatcher.
	WorkflowDispatcher WorkflowKind = "dispatcher"
	// WorkflowTicket identifies one pre-redesign per-ticket execution.
	WorkflowTicket WorkflowKind = "ticket"
	// WorkflowAgent identifies a pre-activation AgentWorkflow child.
	WorkflowAgent WorkflowKind = "agent"
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
	ID      int64             `json:"id"`
	State   LegacyTicketState `json:"state"`
	Version time.Time         `json:"version"`
}

// LegacyRun is an open database Run left by the pre-cutover workflow.
type LegacyRun struct {
	ID        string    `json:"id"`
	TicketID  int64     `json:"ticketId"`
	StartedAt time.Time `json:"startedAt"`
}

// LegacySandbox is one Kubernetes pod owned by the pre-activation sandbox
// lifecycle. UID makes deletion target the object that inventory observed.
type LegacySandbox struct {
	Name   string `json:"name"`
	UID    string `json:"uid"`
	RunID  string `json:"runId"`
	Ticket string `json:"ticket"`
}

// LegacyTicketState is the narrow state vocabulary which cutover can repair.
type LegacyTicketState string

const (
	// LegacyTicketOpen is the state after a successful cutover repair.
	LegacyTicketOpen LegacyTicketState = "open"
	// LegacyTicketWorking is a ticket owned by a running legacy workflow.
	LegacyTicketWorking LegacyTicketState = "working"
	// LegacyTicketReview is a ticket waiting in the legacy review state.
	LegacyTicketReview LegacyTicketState = "review"
)

// Inventory is the complete cutover safety view at one instant.
type Inventory struct {
	Workflows    []WorkflowExecution `json:"workflows"`
	Sandboxes    []LegacySandbox     `json:"sandboxes"`
	PullRequests []PullRequest       `json:"pullRequests"`
	Tickets      []LegacyTicket      `json:"tickets"`
	Runs         []LegacyRun         `json:"runs"`
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

// Sandboxes is the exact legacy-pod inventory and cleanup surface the gate
// needs. Implementations must exclude target Run Worker resources.
type Sandboxes interface {
	ListLegacySandboxes(context.Context) ([]LegacySandbox, error)
	DeleteLegacySandbox(context.Context, LegacySandbox) error
}

// GitHub is the exact old-PR merge-authorization surface the gate needs.
type GitHub interface {
	ListLegacyPullRequests(context.Context) ([]PullRequest, error)
	DisableAutoMerge(context.Context, PullRequest) error
}

// Tickets owns the single transactional legacy-state repair.
type Tickets interface {
	ListLegacyTickets(context.Context) ([]LegacyTicket, error)
	ListLegacyRuns(context.Context) ([]LegacyRun, error)
	ReconcileLegacyState(context.Context, []LegacyTicket, []LegacyRun) ([]LegacyTicket, error)
}

// Dependencies groups the independently fakeable external boundaries.
type Dependencies struct {
	Temporal  Temporal
	Sandboxes Sandboxes
	GitHub    GitHub
	Tickets   Tickets
}

// Execute inventories or applies the idempotent quiesce/reconcile sequence.
func Execute(ctx context.Context, dependencies Dependencies, options Options) (Report, error) {
	report := Report{Version: 2, Mode: options.Mode, Actions: []Action{}}
	if options.Mode != ModeInventory && options.Mode != ModeDryRun && options.Mode != ModeApply {
		return report, fmt.Errorf("cutover mode %q is invalid", options.Mode)
	}
	if dependencies.Temporal == nil || dependencies.Sandboxes == nil || dependencies.GitHub == nil || dependencies.Tickets == nil {
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

	// Re-inventory after the dispatcher query proves the pause was applied. Anything admitted
	// in the initial inventory/pause race is included in this run; anything
	// admitted later is caught by the closure inventory before ticket repair.
	quiesced, err := inventory(ctx, dependencies)
	if err != nil {
		return report, fmt.Errorf("inventorying after dispatcher pause: %w", err)
	}
	dispatchers, legacyWork := splitExecutions(quiesced.Workflows)
	for _, pullRequest := range quiesced.PullRequests {
		if !pullRequest.AutoMergeEnabled {
			continue
		}
		if err := dependencies.GitHub.DisableAutoMerge(ctx, pullRequest); err != nil {
			return report, fmt.Errorf("disabling auto-merge on pull request %d: %w", pullRequest.Number, err)
		}
		report.Actions = append(report.Actions, Action{Kind: "disable_auto_merge", Target: fmt.Sprintf("pull_request/%d", pullRequest.Number), Status: "applied"})
	}
	for _, execution := range legacyWork {
		if err := dependencies.Temporal.CancelLegacyExecution(ctx, execution); err != nil {
			return report, fmt.Errorf("canceling legacy execution %s/%s: %w", execution.ID, execution.RunID, err)
		}
		report.Actions = append(report.Actions, Action{Kind: "cancel_workflow", Target: executionTarget(execution), Status: "applied"})
	}
	for _, execution := range legacyWork {
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
	for _, sandbox := range closedInventory.Sandboxes {
		if err := dependencies.Sandboxes.DeleteLegacySandbox(ctx, sandbox); err != nil {
			return report, fmt.Errorf("deleting legacy sandbox %s/%s: %w", sandbox.Name, sandbox.UID, err)
		}
		report.Actions = append(report.Actions, Action{Kind: "delete_legacy_sandbox", Target: sandboxTarget(sandbox), Status: "applied"})
	}
	if len(closedInventory.Tickets) > 0 || len(closedInventory.Runs) > 0 {
		reopened, err := dependencies.Tickets.ReconcileLegacyState(ctx, closedInventory.Tickets, closedInventory.Runs)
		if err != nil {
			return report, fmt.Errorf("reconciling legacy database state: %w", err)
		}
		for _, run := range closedInventory.Runs {
			report.Actions = append(report.Actions, Action{Kind: "close_legacy_run", Target: "run/" + run.ID, Status: "applied"})
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
	sandboxes, err := dependencies.Sandboxes.ListLegacySandboxes(ctx)
	if err != nil {
		return Inventory{}, fmt.Errorf("listing legacy sandboxes: %w", err)
	}
	pullRequests, err := dependencies.GitHub.ListLegacyPullRequests(ctx)
	if err != nil {
		return Inventory{}, fmt.Errorf("listing legacy pull requests: %w", err)
	}
	tickets, err := dependencies.Tickets.ListLegacyTickets(ctx)
	if err != nil {
		return Inventory{}, fmt.Errorf("listing legacy tickets: %w", err)
	}
	runs, err := dependencies.Tickets.ListLegacyRuns(ctx)
	if err != nil {
		return Inventory{}, fmt.Errorf("listing legacy database runs: %w", err)
	}
	for _, execution := range workflows {
		if execution.Kind != WorkflowDispatcher && execution.Kind != WorkflowTicket && execution.Kind != WorkflowAgent {
			return Inventory{}, fmt.Errorf("legacy workflow %s/%s has unknown kind %q", execution.ID, execution.RunID, execution.Kind)
		}
	}
	sort.Slice(workflows, func(left, right int) bool {
		if workflows[left].Kind != workflows[right].Kind {
			return workflowKindRank(workflows[left].Kind) < workflowKindRank(workflows[right].Kind)
		}
		if workflows[left].ID != workflows[right].ID {
			return workflows[left].ID < workflows[right].ID
		}
		return workflows[left].RunID < workflows[right].RunID
	})
	sort.Slice(sandboxes, func(left, right int) bool {
		if sandboxes[left].Name != sandboxes[right].Name {
			return sandboxes[left].Name < sandboxes[right].Name
		}
		return sandboxes[left].UID < sandboxes[right].UID
	})
	sort.Slice(pullRequests, func(left, right int) bool { return pullRequests[left].Number < pullRequests[right].Number })
	sort.Slice(tickets, func(left, right int) bool { return tickets[left].ID < tickets[right].ID })
	sort.Slice(runs, func(left, right int) bool {
		if runs[left].StartedAt != runs[right].StartedAt {
			return runs[left].StartedAt.Before(runs[right].StartedAt)
		}
		return runs[left].ID < runs[right].ID
	})
	return Inventory{Workflows: nonNil(workflows), Sandboxes: nonNil(sandboxes), PullRequests: nonNil(pullRequests), Tickets: nonNil(tickets), Runs: nonNil(runs)}, nil
}

func ready(inventory Inventory) bool {
	if len(inventory.Workflows) > 0 || len(inventory.Sandboxes) > 0 || len(inventory.Tickets) > 0 || len(inventory.Runs) > 0 {
		return false
	}
	for _, pullRequest := range inventory.PullRequests {
		if pullRequest.AutoMergeEnabled {
			return false
		}
	}
	return true
}

func splitExecutions(executions []WorkflowExecution) (dispatchers, legacyWork []WorkflowExecution) {
	for _, execution := range executions {
		switch execution.Kind {
		case WorkflowDispatcher:
			dispatchers = append(dispatchers, execution)
		case WorkflowTicket, WorkflowAgent:
			legacyWork = append(legacyWork, execution)
		}
	}
	return dispatchers, legacyWork
}

func plannedActions(inventory Inventory) []Action {
	var actions []Action
	dispatchers, legacyWork := splitExecutions(inventory.Workflows)
	if len(dispatchers) > 0 {
		actions = append(actions, Action{Kind: "pause_dispatcher", Target: dispatchers[0].ID, Status: "planned"})
	}
	for _, pullRequest := range inventory.PullRequests {
		if pullRequest.AutoMergeEnabled {
			actions = append(actions, Action{Kind: "disable_auto_merge", Target: fmt.Sprintf("pull_request/%d", pullRequest.Number), Status: "planned"})
		}
	}
	for _, execution := range legacyWork {
		actions = append(actions, Action{Kind: "cancel_then_terminate_workflow", Target: executionTarget(execution), Status: "planned"})
	}
	for _, dispatcher := range dispatchers {
		actions = append(actions, Action{Kind: "terminate_dispatcher", Target: executionTarget(dispatcher), Status: "planned"})
	}
	for _, sandbox := range inventory.Sandboxes {
		actions = append(actions, Action{Kind: "delete_legacy_sandbox", Target: sandboxTarget(sandbox), Status: "planned"})
	}
	for _, run := range inventory.Runs {
		actions = append(actions, Action{Kind: "close_legacy_run", Target: "run/" + run.ID, Status: "planned"})
	}
	for _, ticket := range inventory.Tickets {
		actions = append(actions, Action{Kind: "reopen_ticket", Target: fmt.Sprintf("ticket/%d", ticket.ID), Status: "planned"})
	}
	return nonNil(actions)
}

func executionTarget(execution WorkflowExecution) string {
	return execution.ID + "/" + execution.RunID
}

func sandboxTarget(sandbox LegacySandbox) string {
	return sandbox.Name + "/" + sandbox.UID
}

func workflowKindRank(kind WorkflowKind) int {
	switch kind {
	case WorkflowDispatcher:
		return 0
	case WorkflowTicket:
		return 1
	case WorkflowAgent:
		return 2
	default:
		return 3
	}
}

func nonNil[T any](values []T) []T {
	if values == nil {
		return []T{}
	}
	return values
}
