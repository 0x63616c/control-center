package work_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// The literal strings below are asserted rather than derived. These paths and
// this ID are a wire format: the workflow ID is the claim on a ticket, and the
// sandbox paths are the contract with the sandbox image. Recomputing them the
// way the code does would assert nothing, so a change that alters them has to
// change this test too, deliberately.

func TestWorkflowIDIsStableForATicket(t *testing.T) {
	t.Parallel()

	if got, want := work.WorkflowID(312), "work-ticket-312"; got != want {
		t.Errorf("WorkflowID(312) = %q, want %q — this string IS the claim; changing it lets a ticket be claimed twice", got, want)
	}
}

func TestStagePathsAreDerivedFromTheKeyAlone(t *testing.T) {
	t.Parallel()

	key := work.StageKey{Ticket: 312, RunID: "0198c2f1", Stage: work.StagePlan}
	paths := key.Paths()

	for _, tc := range []struct{ name, got, want string }{
		{"Dir", paths.Dir, "/work/0198c2f1/plan"},
		{"Prompt", paths.Prompt, "/work/0198c2f1/plan/prompt.md"},
		{"Schema", paths.Schema, "/work/0198c2f1/plan/schema.json"},
		{"Result", paths.Result, "/work/0198c2f1/plan/result.json"},
		{"PID", paths.PID, "/work/0198c2f1/plan/codex.pid"},
	} {
		if tc.got != tc.want {
			t.Errorf("Paths().%s = %q, want %q", tc.name, tc.got, tc.want)
		}
	}
}

func TestStagePathsSeparateRunsOfTheSameStage(t *testing.T) {
	t.Parallel()

	first := work.StageKey{Ticket: 312, RunID: "run-a", Stage: work.StageImplement}.Paths()
	second := work.StageKey{Ticket: 312, RunID: "run-b", Stage: work.StageImplement}.Paths()

	if first.Result == second.Result {
		t.Error("two runs of a ticket share a result path; a re-run would read the previous run's output as its own")
	}
}

func TestTranscriptPathKeepsAttemptsSeparatelyInspectable(t *testing.T) {
	t.Parallel()

	key := work.StageKey{Ticket: 312, RunID: "0198c2f1", Stage: work.StageReview}
	if got, want := key.TranscriptPath(), "312/0198c2f1/review.jsonl"; got != want {
		t.Errorf("TranscriptPath() = %q, want %q", got, want)
	}
}

func TestPipelineOrdersTheStages(t *testing.T) {
	t.Parallel()

	want := []work.Stage{
		work.StagePlan, work.StageReview, work.StageRevise, work.StageImplement, work.StagePropose,
	}
	got := work.Pipeline()
	if len(got) != len(want) {
		t.Fatalf("Pipeline() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("Pipeline() = %v, want %v", got, want)
		}
	}
}

func TestPipelineCannotBeReorderedByACaller(t *testing.T) {
	t.Parallel()

	work.Pipeline()[0] = work.StagePropose
	if got := work.Pipeline()[0]; got != work.StagePlan {
		t.Errorf("Pipeline()[0] = %v after a caller wrote to a previous result, want %v", got, work.StagePlan)
	}
}

func TestUsageAddsAcrossStages(t *testing.T) {
	t.Parallel()

	total := work.Usage{InputTokens: 10, CachedInputTokens: 2, OutputTokens: 3, ReasoningTokens: 4}.
		Add(work.Usage{InputTokens: 1, CachedInputTokens: 1, OutputTokens: 1, ReasoningTokens: 1})

	want := work.Usage{InputTokens: 11, CachedInputTokens: 3, OutputTokens: 4, ReasoningTokens: 5}
	if total != want {
		t.Errorf("Add = %+v, want %+v", total, want)
	}
}

const secret = "sk-not-a-real-token"

func TestCredentialRevealsOnlyWhenAsked(t *testing.T) {
	t.Parallel()

	if got := work.NewCredential(secret).Reveal(); got != secret {
		t.Errorf("Reveal() = %q, want the wrapped value", got)
	}
}

func TestCredentialStaysOutOfFormattedOutput(t *testing.T) {
	t.Parallel()

	c := work.NewCredential(secret)

	// %v on a struct containing one is the realistic leak: nobody formats the
	// credential deliberately.
	wrapper := struct{ Token work.Credential }{Token: c}
	rendered := []string{
		c.String(),
		fmt.Sprintf("%v", c.LogValue()),
		fmt.Sprintf("%v", wrapper),
		fmt.Sprintf("%+v", wrapper),
	}
	for _, r := range rendered {
		if strings.Contains(r, secret) {
			t.Errorf("rendered credential contains the secret: %q", r)
		}
	}
}

func TestCredentialRefusesToBeSerialised(t *testing.T) {
	t.Parallel()

	// Marshalling is how a credential would reach workflow history or a
	// Kubernetes object and outlive the run that fetched it. Failing loudly
	// beats silently writing "[redacted]" where a token was expected.
	if _, err := json.Marshal(work.NewCredential(secret)); err == nil {
		t.Error("json.Marshal accepted a Credential; a token could be persisted to workflow history")
	}
}

func TestPermanentSurvivesWrapping(t *testing.T) {
	t.Parallel()

	// The marker is only useful if it reaches the activity boundary through the
	// layers of context every error picks up on the way up.
	wrapped := fmt.Errorf("creating the sandbox for ticket #312: %w", work.ErrPermanent)
	if !errors.Is(wrapped, work.ErrPermanent) {
		t.Error("a wrapped ErrPermanent no longer reports as permanent; the retry decision would silently flip to retryable")
	}
}

func TestPermanentIsDistinctFromOtherSentinels(t *testing.T) {
	t.Parallel()

	if errors.Is(work.ErrFileNotFound, work.ErrPermanent) {
		t.Error("a missing sandbox file reports as permanent; absence is a signal a stage keys off, not a reason to stop retrying")
	}
}

func TestSandboxSpecCarriesTheRunIDInTheSameFormAsAStageKey(t *testing.T) {
	t.Parallel()

	// One representation of a run id, not two: a pod named from the spec and a
	// path derived from the key have to agree about which run they belong to.
	key := work.StageKey{Ticket: 312, RunID: "0198c2f1", Stage: work.StagePlan}
	spec := work.SandboxSpec{TicketNumber: key.Ticket, RunID: key.RunID}

	if spec.RunID != key.RunID {
		t.Errorf("SandboxSpec.RunID = %q, want %q", spec.RunID, key.RunID)
	}
}

func TestAnObservedVersionIsAPrecondition(t *testing.T) {
	t.Parallel()

	v := work.ObservedVersion("41208")
	if v.Token() != "41208" {
		t.Errorf("Token() = %q, want the observed token", v.Token())
	}
	if v.IsUnconditional() || v.IsZero() {
		t.Error("an observed version does not constrain the write it is handed to")
	}
}

func TestAnEmptyTokenNeverBecomesAPrecondition(t *testing.T) {
	t.Parallel()

	// An empty resourceVersion is an unconditional overwrite to the Kubernetes
	// apiserver, so a store that read "" and passed it on would silently write
	// blind. It has to arrive as the zero value a store must refuse instead.
	v := work.ObservedVersion("")
	if !v.IsZero() || v.IsUnconditional() {
		t.Error("an empty token produced a usable version; a lease would be silently disarmed")
	}
}

func TestTheZeroVersionIsAPreconditionNoStoreCanSatisfy(t *testing.T) {
	t.Parallel()

	var v work.SecretVersion
	if !v.IsZero() {
		t.Error("the zero SecretVersion does not report itself as one")
	}
	if v.IsUnconditional() {
		t.Error("a forgotten version reads as an unconditional overwrite")
	}
}

func TestAnUnconditionalWriteMustBeAskedForByName(t *testing.T) {
	t.Parallel()

	v := work.Unconditional()
	if !v.IsUnconditional() {
		t.Error("Unconditional() does not report itself as unconditional")
	}
	if v.IsZero() {
		t.Error("Unconditional() reads as a forgotten version; a store would refuse a deliberate blind write")
	}
}
