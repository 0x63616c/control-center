package cutover

import (
	"context"
	"encoding/json"
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
			if len(report.Before.Workflows) != 3 || len(report.Before.PullRequests) != 1 || len(report.Before.Tickets) != 2 {
				t.Fatalf("inventory = %+v, want three workflows, one PR, two Tickets", report.Before)
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
	if !report.Ready || len(report.After.Workflows) != 0 || len(report.After.PullRequests) != 0 || len(report.After.Tickets) != 0 {
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
		"terminate-dispatcher:software-factory-ticket-dispatcher/dispatcher-run",
		"reopen-legacy-tickets",
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
	workflows    []WorkflowExecution
	pullRequests []PullRequest
	tickets      []LegacyTicket
	calls        []string
}

func newFakeDependencies() *fakeDependencies {
	return &fakeDependencies{
		workflows: []WorkflowExecution{
			{ID: "software-factory-ticket-dispatcher", RunID: "dispatcher-run", Kind: WorkflowDispatcher},
			{ID: "factory-ticket-7", RunID: "run-7", Kind: WorkflowTicket},
			{ID: "factory-ticket-8", RunID: "run-8", Kind: WorkflowTicket},
		},
		pullRequests: []PullRequest{{Number: 41, NodeID: "PR_41", Branch: "factory/ticket-7/run-7", AutoMergeEnabled: true}},
		tickets:      []LegacyTicket{{ID: 7, State: "working"}, {ID: 8, State: "review"}},
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
	return false, nil
}

func (fake *fakeDependencies) TerminateLegacyExecution(_ context.Context, execution WorkflowExecution) error {
	fake.calls = append(fake.calls, "terminate:"+execution.ID+"/"+execution.RunID)
	fake.removeWorkflow(execution)
	return nil
}

func (fake *fakeDependencies) TerminateLegacyDispatcher(_ context.Context, execution WorkflowExecution) error {
	fake.calls = append(fake.calls, "terminate-dispatcher:"+execution.ID+"/"+execution.RunID)
	fake.removeWorkflow(execution)
	return nil
}

func (fake *fakeDependencies) ListLegacyPullRequests(context.Context) ([]PullRequest, error) {
	return append([]PullRequest(nil), fake.pullRequests...), nil
}

func (fake *fakeDependencies) DisableAutoMerge(_ context.Context, pullRequest PullRequest) error {
	fake.calls = append(fake.calls, "disable-auto-merge:"+itoa(pullRequest.Number))
	fake.pullRequests = nil
	return nil
}

func (fake *fakeDependencies) ListLegacyTickets(context.Context) ([]LegacyTicket, error) {
	return append([]LegacyTicket(nil), fake.tickets...), nil
}

func (fake *fakeDependencies) ReopenLegacyTickets(context.Context) ([]LegacyTicket, error) {
	fake.calls = append(fake.calls, "reopen-legacy-tickets")
	reopened := append([]LegacyTicket(nil), fake.tickets...)
	fake.tickets = nil
	return reopened, nil
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
	const digits = "0123456789"
	if value == 0 {
		return "0"
	}
	var reversed [20]byte
	index := len(reversed)
	for value > 0 {
		index--
		reversed[index] = digits[value%10]
		value /= 10
	}
	return string(reversed[index:])
}
