package cutover

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"testing"
	"time"
)

func TestInventoryAndDryRunAreInertAndMachineReadable(t *testing.T) {
	t.Parallel()
	for _, mode := range []Mode{ModeInventory, ModeDryRun} {
		mode := mode
		t.Run(string(mode), func(t *testing.T) {
			t.Parallel()
			fake := newFakeDependencies()
			report, err := Execute(context.Background(), fake.dependencies(), Options{Mode: mode, GracePeriod: time.Second})
			if err != nil {
				t.Fatalf("Execute: %v", err)
			}
			if report.Ready {
				t.Fatalf("Ready = true with legacy inventory: %+v", report)
			}
			if len(report.Before.Workflows) != 3 || len(report.Before.PullRequests) != 1 || len(report.Before.Tickets) != 2 || len(report.Before.Runs) != 2 {
				t.Fatalf("inventory = %+v, want three workflows, one PR, two Tickets, and two open legacy Runs", report.Before)
			}
			if len(fake.calls) != 0 {
				t.Fatalf("mutating calls = %v, want none in %s", fake.calls, mode)
			}
			encoded, err := json.Marshal(report)
			if err != nil {
				t.Fatalf("Marshal: %v", err)
			}
			if !json.Valid(encoded) {
				t.Fatalf("report is not JSON: %s", encoded)
			}
		})
	}
}

func TestApplyQuiescesLegacyWorkAndIsIdempotent(t *testing.T) {
	t.Parallel()
	fake := newFakeDependencies()
	report, err := Execute(context.Background(), fake.dependencies(), Options{Mode: ModeApply, GracePeriod: time.Second})
	if err != nil {
		t.Fatalf("Execute(first): %v", err)
	}
	if !report.Ready || len(report.After.Workflows) != 0 || len(report.After.PullRequests) != 1 || report.After.PullRequests[0].AutoMergeEnabled || len(report.After.Tickets) != 0 || len(report.After.Runs) != 0 {
		t.Fatalf("report = %+v, want a clean ready inventory", report)
	}
	wantCalls := []string{
		"pause-dispatcher",
		"disable-auto-merge:41",
		"cancel:factory-ticket-7/run-7",
		"cancel:factory-ticket-8/run-8",
		"await:factory-ticket-7/run-7",
		"await:factory-ticket-8/run-8",
		"terminate:factory-ticket-8/run-8",
		"await:factory-ticket-8/run-8",
		"terminate-dispatcher:software-factory-ticket-dispatcher/dispatcher-run",
		"await:software-factory-ticket-dispatcher/dispatcher-run",
		"reconcile-legacy-state:7@working,8@review;runs:run-7,run-8",
	}
	if diff := stringSliceDiff(fake.calls, wantCalls); diff != "" {
		t.Fatal(diff)
	}

	fake.calls = nil
	second, err := Execute(context.Background(), fake.dependencies(), Options{Mode: ModeApply, GracePeriod: time.Second})
	if err != nil {
		t.Fatalf("Execute(second): %v", err)
	}
	if !second.Ready || len(fake.calls) != 0 {
		t.Fatalf("second apply = %+v calls=%v, want ready no-op", second, fake.calls)
	}
}

func TestApplyReturnsTypedNotReadyWithTheFinalReport(t *testing.T) {
	t.Parallel()
	fake := newFakeDependencies()
	fake.asynchronousTermination = true

	report, err := Execute(context.Background(), fake.dependencies(), Options{Mode: ModeApply, GracePeriod: time.Second})
	var notReady *NotReadyError
	if !errors.As(err, &notReady) {
		t.Fatalf("error = %v, want *NotReadyError", err)
	}
	if report.Ready || notReady.Report.Ready || len(report.After.Workflows) == 0 {
		t.Fatalf("report = %+v error report = %+v, want retained final non-ready inventory", report, notReady.Report)
	}
	for _, call := range fake.calls {
		if call[:min(len(call), len("reopen-legacy-tickets"))] == "reopen-legacy-tickets" {
			t.Fatalf("reopened Tickets before proving workflow closure: calls=%v", fake.calls)
		}
	}
}

func TestApplyRejectsUnknownLegacyWorkflowKindBeforeMutation(t *testing.T) {
	t.Parallel()
	fake := newFakeDependencies()
	fake.workflows = append(fake.workflows, WorkflowExecution{ID: "mystery", RunID: "run", Kind: "unknown"})

	if _, err := Execute(context.Background(), fake.dependencies(), Options{Mode: ModeApply, GracePeriod: time.Second}); err == nil {
		t.Fatal("Execute accepted an unknown workflow kind")
	}
	if len(fake.calls) != 0 {
		t.Fatalf("mutating calls = %v, want none", fake.calls)
	}
}

func TestApplyCanResumeAfterAnAutoMergeFailure(t *testing.T) {
	t.Parallel()
	fake := newFakeDependencies()
	fake.disableAutoMergeFailures = 1

	if _, err := Execute(context.Background(), fake.dependencies(), Options{Mode: ModeApply, GracePeriod: time.Second}); err == nil {
		t.Fatal("first Execute succeeded despite the injected GitHub failure")
	}
	report, err := Execute(context.Background(), fake.dependencies(), Options{Mode: ModeApply, GracePeriod: time.Second})
	if err != nil || !report.Ready {
		t.Fatalf("second Execute = %+v, %v; want an idempotent successful rerun", report, err)
	}
}

func TestApplyRefusesAStaleTicketSnapshot(t *testing.T) {
	t.Parallel()
	fake := newFakeDependencies()
	fake.staleTicketOnReopen = true

	report, err := Execute(context.Background(), fake.dependencies(), Options{Mode: ModeApply, GracePeriod: time.Second})
	if err == nil {
		t.Fatal("Execute reopened a Ticket whose state/version changed after inventory")
	}
	if report.Ready {
		t.Fatalf("report = %+v, want not ready", report)
	}
}

func TestExecuteRefusesUnknownModeBeforeMutation(t *testing.T) {
	t.Parallel()
	fake := newFakeDependencies()
	if _, err := Execute(context.Background(), fake.dependencies(), Options{Mode: "launch", GracePeriod: time.Second}); err == nil {
		t.Fatal("Execute accepted an unknown mode")
	}
	if len(fake.calls) != 0 {
		t.Fatalf("mutating calls = %v, want none", fake.calls)
	}
}

type fakeDependencies struct {
	workflows                []WorkflowExecution
	pullRequests             []PullRequest
	tickets                  []LegacyTicket
	runs                     []LegacyRun
	calls                    []string
	disableAutoMergeFailures int
	asynchronousTermination  bool
	staleTicketOnReopen      bool
}

func newFakeDependencies() *fakeDependencies {
	versionSeven := time.Date(2026, time.July, 31, 7, 0, 0, 0, time.UTC)
	versionEight := versionSeven.Add(time.Minute)
	return &fakeDependencies{
		workflows: []WorkflowExecution{
			{ID: "software-factory-ticket-dispatcher", RunID: "dispatcher-run", Kind: WorkflowDispatcher},
			{ID: "factory-ticket-7", RunID: "run-7", Kind: WorkflowTicket},
			{ID: "factory-ticket-8", RunID: "run-8", Kind: WorkflowTicket},
		},
		pullRequests: []PullRequest{{Number: 41, NodeID: "PR_41", Branch: "factory/ticket-7/run-7", AutoMergeEnabled: true}},
		tickets: []LegacyTicket{
			{ID: 7, State: LegacyTicketWorking, Version: versionSeven},
			{ID: 8, State: LegacyTicketReview, Version: versionEight},
		},
		runs: []LegacyRun{{ID: "run-7", TicketID: 7}, {ID: "run-8", TicketID: 8}},
	}
}

func (fake *fakeDependencies) dependencies() Dependencies {
	return Dependencies{Temporal: fake, GitHub: fake, Tickets: fake}
}

func (fake *fakeDependencies) ListLegacyExecutions(context.Context) ([]WorkflowExecution, error) {
	return append([]WorkflowExecution(nil), fake.workflows...), nil
}

func (fake *fakeDependencies) PauseLegacyDispatcher(context.Context) error {
	fake.calls = append(fake.calls, "pause-dispatcher")
	return nil
}

func (fake *fakeDependencies) CancelLegacyExecution(_ context.Context, execution WorkflowExecution) error {
	fake.calls = append(fake.calls, "cancel:"+execution.ID+"/"+execution.RunID)
	return nil
}

func (fake *fakeDependencies) AwaitLegacyExecutionClosed(_ context.Context, execution WorkflowExecution, _ time.Duration) (bool, error) {
	fake.calls = append(fake.calls, "await:"+execution.ID+"/"+execution.RunID)
	if execution.ID == "factory-ticket-7" {
		fake.removeWorkflow(execution)
		return true, nil
	}
	if !fake.asynchronousTermination && fake.wasTerminated(execution) {
		fake.removeWorkflow(execution)
		return true, nil
	}
	return false, nil
}

func (fake *fakeDependencies) TerminateLegacyExecution(_ context.Context, execution WorkflowExecution) error {
	fake.calls = append(fake.calls, "terminate:"+execution.ID+"/"+execution.RunID)
	return nil
}

func (fake *fakeDependencies) TerminateLegacyDispatcher(_ context.Context, execution WorkflowExecution) error {
	fake.calls = append(fake.calls, "terminate-dispatcher:"+execution.ID+"/"+execution.RunID)
	return nil
}

func (fake *fakeDependencies) ListLegacyPullRequests(context.Context) ([]PullRequest, error) {
	return append([]PullRequest(nil), fake.pullRequests...), nil
}

func (fake *fakeDependencies) DisableAutoMerge(_ context.Context, pullRequest PullRequest) error {
	fake.calls = append(fake.calls, "disable-auto-merge:"+itoa(pullRequest.Number))
	if fake.disableAutoMergeFailures > 0 {
		fake.disableAutoMergeFailures--
		return fmt.Errorf("injected GitHub failure")
	}
	for index := range fake.pullRequests {
		if fake.pullRequests[index].Number == pullRequest.Number {
			fake.pullRequests[index].AutoMergeEnabled = false
		}
	}
	return nil
}

func (fake *fakeDependencies) ListLegacyTickets(context.Context) ([]LegacyTicket, error) {
	return append([]LegacyTicket(nil), fake.tickets...), nil
}

func (fake *fakeDependencies) ListLegacyRuns(context.Context) ([]LegacyRun, error) {
	return append([]LegacyRun(nil), fake.runs...), nil
}

func (fake *fakeDependencies) ReconcileLegacyState(_ context.Context, expected []LegacyTicket, runs []LegacyRun) ([]LegacyTicket, error) {
	target := "reopen-legacy-tickets:"
	for index, ticket := range expected {
		if index > 0 {
			target += ","
		}
		target += strconv.FormatInt(ticket.ID, 10) + "@" + string(ticket.State)
	}
	target = "reconcile-legacy-state:" + target[len("reopen-legacy-tickets:"):] + ";runs:"
	for index, run := range runs {
		if index > 0 {
			target += ","
		}
		target += run.ID
	}
	fake.calls = append(fake.calls, target)
	if fake.staleTicketOnReopen {
		fake.tickets[0].Version = fake.tickets[0].Version.Add(time.Nanosecond)
	}
	if len(expected) != len(fake.tickets) {
		return nil, fmt.Errorf("legacy ticket inventory changed")
	}
	for index := range expected {
		if expected[index] != fake.tickets[index] {
			return nil, fmt.Errorf("legacy ticket %d changed", expected[index].ID)
		}
	}
	reopened := append([]LegacyTicket(nil), expected...)
	for index := range reopened {
		reopened[index].State = LegacyTicketOpen
	}
	fake.tickets = nil
	fake.runs = nil
	return reopened, nil
}

func (fake *fakeDependencies) wasTerminated(execution WorkflowExecution) bool {
	wantTicket := "terminate:" + execution.ID + "/" + execution.RunID
	wantDispatcher := "terminate-dispatcher:" + execution.ID + "/" + execution.RunID
	for _, call := range fake.calls {
		if call == wantTicket || call == wantDispatcher {
			return true
		}
	}
	return false
}

func (fake *fakeDependencies) removeWorkflow(execution WorkflowExecution) {
	kept := fake.workflows[:0]
	for _, candidate := range fake.workflows {
		if candidate.ID != execution.ID || candidate.RunID != execution.RunID {
			kept = append(kept, candidate)
		}
	}
	fake.workflows = kept
}

func stringSliceDiff(got, want []string) string {
	if len(got) != len(want) {
		return "calls length differs"
	}
	for index := range got {
		if got[index] != want[index] {
			return "calls differ at index " + itoa(index) + ": got " + got[index] + ", want " + want[index]
		}
	}
	return ""
}

func itoa(value int) string {
	return strconv.Itoa(value)
}
