package prompts

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// documentEnvelope is codex's wire shape for the four stages that answer in
// a single prose field: plan, review, revise, propose.
//
// It carries codex's own field spellings — this is the schema-facing type,
// distinct from work.DocumentOutput, which is a Go-to-Go encoding across a
// worker redeploy and has no reason to share tags with what codex was told
// to answer. See "Two encodings, deliberately separate" in this step's spec.
type documentEnvelope struct {
	// Raw rather than *string, so an absent field and a present-but-null one
	// are told apart. They are different failures — a stage that answered in
	// some other shape, and a stage that answered in this one and put nothing
	// in it — and an error naming the wrong one sends whoever is debugging
	// the run after a schema mismatch that is not there.
	Document json.RawMessage `json:"document"`
}

// implementEnvelope is codex's wire shape for the implement stage: its
// report, plus whether it finished.
type implementEnvelope struct {
	Report        json.RawMessage `json:"report"`
	Blocked       *bool           `json:"blocked"`
	BlockedReason *string         `json:"blocked_reason"`
}

// decodeDocumentEnvelope reads a stage's result envelope and returns the one
// prose field it holds.
//
// It is strict, and every rejection below is a stage that did not do its
// job: an unreadable result means the stage failed, and the run is worth
// failing visibly rather than carrying an empty or half-guessed document
// into the next prompt. Unknown fields are rejected too — the schema says
// additionalProperties false, and accepting more here would let the two
// disagree quietly.
func decodeDocumentEnvelope(result []byte) (string, error) {
	var envelope documentEnvelope

	decoder := json.NewDecoder(bytes.NewReader(result))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return "", fmt.Errorf("reading the stage's result envelope: %w", err)
	}
	// A second value after the envelope means the file holds more than the
	// final message — a stage that appended, or a retry that wrote twice.
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return "", fmt.Errorf("the stage's result holds more than one envelope; only its final message is its output")
	}
	if envelope.Document == nil {
		return "", fmt.Errorf("the stage's result has no document field: it returned something other than the envelope it was given")
	}
	if string(envelope.Document) == "null" {
		return "", fmt.Errorf("the stage's result sets document to null: it answered in the envelope and put nothing in it")
	}

	var document string
	if err := json.Unmarshal(envelope.Document, &document); err != nil {
		return "", fmt.Errorf("reading the stage's document out of its result envelope: %w", err)
	}
	if strings.TrimSpace(document) == "" {
		return "", fmt.Errorf("the stage returned an empty document: it produced no handoff at all")
	}
	return document, nil
}

// decodeImplementEnvelope reads the implement stage's result envelope: its
// report, plus whether it finished.
//
// Strict in the same ways decodeDocumentEnvelope is, plus one more: blocked
// and blocked_reason travel together. A blocked run with no reason told
// nobody what it needed, and a blocked_reason on a run that says it finished
// is a stage contradicting itself.
func decodeImplementEnvelope(result []byte) (report string, blocked bool, blockedReason string, err error) {
	var envelope implementEnvelope

	decoder := json.NewDecoder(bytes.NewReader(result))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return "", false, "", fmt.Errorf("reading the stage's result envelope: %w", err)
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return "", false, "", fmt.Errorf("the stage's result holds more than one envelope; only its final message is its output")
	}
	if envelope.Report == nil {
		return "", false, "", fmt.Errorf("the stage's result has no report field: it returned something other than the envelope it was given")
	}
	if string(envelope.Report) == "null" {
		return "", false, "", fmt.Errorf("the stage's result sets report to null: it answered in the envelope and put nothing in it")
	}
	if err := json.Unmarshal(envelope.Report, &report); err != nil {
		return "", false, "", fmt.Errorf("reading the stage's report out of its result envelope: %w", err)
	}
	if strings.TrimSpace(report) == "" {
		return "", false, "", fmt.Errorf("the stage returned an empty report: it produced no handoff at all")
	}
	if envelope.Blocked == nil {
		return "", false, "", fmt.Errorf("the stage's result has no blocked field: it returned something other than the envelope it was given")
	}
	if envelope.BlockedReason == nil {
		return "", false, "", fmt.Errorf("the stage's result has no blocked_reason field: it returned something other than the envelope it was given")
	}
	switch {
	case *envelope.Blocked && strings.TrimSpace(*envelope.BlockedReason) == "":
		return "", false, "", fmt.Errorf("the stage says it is blocked but gives no blocked_reason")
	case !*envelope.Blocked && strings.TrimSpace(*envelope.BlockedReason) != "":
		return "", false, "", fmt.Errorf("the stage gives a blocked_reason but says blocked is false")
	}

	return report, *envelope.Blocked, *envelope.BlockedReason, nil
}

// Decode reads a stage's result envelope — codex's answer to
// templates/<stage>.schema.json — into the domain's StageOutput.
//
// Exhaustive, no default: a sixth stage needs a case here before it
// compiles, matching stageTemplate and work.decodeStageOutputValue.
//
// This must only ever be called from activity code — today, exclusively
// activities.RunStage. It calls work.NewStageOutput, which panics on a
// stage/shape mismatch; that panic is only safe on the activity side of the
// workflow/activity boundary (see NewStageOutput's doc comment). Calling
// Decode from internal/workflows/** would risk a workflow-task panic that
// Temporal retries forever instead of failing the run — depguard already
// forbids that package from importing this one at all, so this is enforced
// mechanically, not only by this comment.
func Decode(stage work.Stage, result []byte) (work.StageOutput, error) {
	switch stage {
	case work.StagePlan, work.StageReview, work.StageRevise, work.StagePropose:
		document, err := decodeDocumentEnvelope(result)
		if err != nil {
			return work.StageOutput{}, err
		}
		return work.NewStageOutput(stage, work.DocumentOutput{Document: document}), nil
	case work.StageImplement:
		report, blocked, blockedReason, err := decodeImplementEnvelope(result)
		if err != nil {
			return work.StageOutput{}, err
		}
		return work.NewStageOutput(stage, work.ImplementOutput{
			Report: report, Blocked: blocked, BlockedReason: blockedReason,
		}), nil
	}
	return work.StageOutput{}, fmt.Errorf("no decoder for stage %q", stage)
}
