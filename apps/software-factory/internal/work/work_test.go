package work_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
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

func TestCredentialFileRevealsItsBytesOnlyWhenAsked(t *testing.T) {
	t.Parallel()

	doc := []byte(`{"tokens":{"access_token":"` + secret + `"}}`)

	if got := work.NewCredentialFile(doc).Reveal(); string(got) != string(doc) {
		t.Errorf("Reveal() = %q, want the wrapped document", got)
	}
}

func TestCredentialFileStaysOutOfFormattedOutput(t *testing.T) {
	t.Parallel()

	f := work.NewCredentialFile([]byte(`{"tokens":{"access_token":"` + secret + `"}}`))

	wrapper := struct{ File work.CredentialFile }{File: f}
	rendered := []string{
		f.String(),
		fmt.Sprintf("%v", f.LogValue()),
		fmt.Sprintf("%v", wrapper),
		fmt.Sprintf("%+v", wrapper),
	}
	for _, r := range rendered {
		if strings.Contains(r, secret) {
			t.Errorf("rendered credential file contains the secret: %q", r)
		}
	}
}

// Credential.LogValue returns `any`, which does NOT satisfy slog.LogValuer, so
// slog never calls it — nothing leaks today only because slog falls through to
// String(). CredentialFile must not inherit that: a document is exactly the
// shape somebody logs whole, so the protection has to be real rather than
// incidental. Asserting the interface is what makes it so.
func TestCredentialFileRedactsItselfThroughTheInterfaceSlogActuallyUses(t *testing.T) {
	t.Parallel()

	var _ slog.LogValuer = work.CredentialFile{}

	var buf bytes.Buffer
	slog.New(slog.NewTextHandler(&buf, nil)).Info("writing the sandbox credential",
		"file", work.NewCredentialFile([]byte(`{"tokens":{"access_token":"`+secret+`"}}`)))

	if strings.Contains(buf.String(), secret) {
		t.Errorf("slog wrote the credential document: %q", buf.String())
	}
}

func TestCredentialFileRefusesToBeSerialised(t *testing.T) {
	t.Parallel()

	// A document is the shape somebody would return from an activity, and
	// Temporal would persist it to workflow history for the whole retention.
	if _, err := json.Marshal(work.NewCredentialFile([]byte(`{}`))); err == nil {
		t.Error("json.Marshal accepted a CredentialFile; a credential document could be persisted to workflow history")
	}
}

// Reveal hands out the backing array, so a caller that mutates what it is given
// would edit the file every later caller receives.
func TestCredentialFileCannotBeMutatedThroughWhatItHandsOut(t *testing.T) {
	t.Parallel()

	f := work.NewCredentialFile([]byte(`{"a":1}`))

	revealed := f.Reveal()
	revealed[0] = 'X'

	if got := string(f.Reveal()); got != `{"a":1}` {
		t.Errorf("mutating a revealed document changed the CredentialFile: %q", got)
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

func TestAnObservedVersionAppliesItselfToTheWrite(t *testing.T) {
	t.Parallel()

	got, err := work.ObservedVersion("41208").Precondition()
	if err != nil {
		t.Fatalf("Precondition() on an observed version: %v", err)
	}
	if got != "41208" {
		t.Errorf("Precondition() = %q, want the observed token", got)
	}
}

func TestAnEmptyTokenNeverBecomesAPrecondition(t *testing.T) {
	t.Parallel()

	// An empty resourceVersion is an unconditional overwrite to the Kubernetes
	// apiserver, so a store that read "" and passed it on would silently write
	// blind. It has to arrive as a refusal instead.
	if _, err := work.ObservedVersion("").Precondition(); !errors.Is(err, work.ErrNoPrecondition) {
		t.Errorf("Precondition() on an empty token = %v, want a refusal; a lease would be silently disarmed", err)
	}
}

func TestAForgottenVersionCannotYieldAUsablePrecondition(t *testing.T) {
	t.Parallel()

	// The whole point of the type: the natural implementation assigns what it
	// gets straight onto the write, so a dropped or unset version must not be
	// able to hand back the empty string that means "overwrite blindly".
	var forgotten work.SecretVersion
	if _, err := forgotten.Precondition(); !errors.Is(err, work.ErrNoPrecondition) {
		t.Errorf("Precondition() on the zero version = %v, want a refusal", err)
	}
}

func TestAForgottenVersionIsDistinguishableFromContention(t *testing.T) {
	t.Parallel()

	// A store refusing a caller's mistake and a store reporting someone else's
	// write are opposite instructions: one is a bug to fix, the other is a
	// conflict to handle.
	_, err := work.SecretVersion{}.Precondition()
	if errors.Is(err, work.ErrVersionConflict) {
		t.Error("a missing precondition reports as a version conflict; a caller would retry its own bug")
	}
}

func TestAnUnconditionalWriteMustBeAskedForByName(t *testing.T) {
	t.Parallel()

	got, err := work.Unconditional().Precondition()
	if err != nil {
		t.Fatalf("Precondition() on a deliberate blind write: %v", err)
	}
	if got != "" {
		t.Errorf("Precondition() = %q, want the empty precondition that constrains nothing", got)
	}
}
