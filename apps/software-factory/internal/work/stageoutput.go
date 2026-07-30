package work

import (
	"encoding/json"
	"fmt"
)

// StageOutput is what one stage produced: a closed sum type over the
// pipeline's per-stage shapes. Its dynamic value is always exactly one
// stage's own output type — never a struct wide enough to hold two stages'
// fields — so nothing downstream can read a Verdict off a value implement
// produced. Build one with NewStageOutput; the zero value has no output
// value in it and Prose() answers "" for it (see below) rather than panicking
// on a stage that has not run yet.
type StageOutput struct {
	stage Stage
	value stageOutputValue
}

// stageOutputValue is what every stage's own output type implements. It is
// unexported: the set of shapes that can back a StageOutput is closed to
// this package, exactly like Pipeline() closes the set of stages — a sixth
// shape has to be added here, in decodeStageOutputValue's exhaustive switch,
// to exist at all.
type stageOutputValue interface {
	// Prose is the plain-text handoff this output contributes forward — to a
	// later stage's prompt, and to the run's status comment. It is never the
	// whole of a stage's structured output, only the part meant to be read
	// as prose. Every stage has one today; step 5's review may not.
	Prose() string
}

// NewStageOutput pairs a stage with its own output value. The prompts
// package is the only intended caller — its Decode function is what keeps
// the pairing honest, via the same exhaustive-switch-over-Stage idiom
// stageTemplate already uses.
//
// This is the one place that pairing is checked: decodeStageOutputValue and
// prompts.Decode are two exhaustive switches over Stage, kept in sync by
// convention alone — the same pattern stageTemplate/reads/documentVar already
// relied on — so nothing stops the two drifting (prompts.Decode wiring
// StageImplement to a DocumentOutput, say). The sum type already makes that
// mistake narrower than the flat struct it replaced — a StageOutput can never
// hold a blend of two stages' fields, only a mislabeled whole one — but a
// drift like that would otherwise be silent until something type-asserted the
// wrong concrete type at read time, in unrelated code, far from the mistake.
// panic() rather than a returned error: this is a programmer error in this
// package's own two switches, not a runtime input problem — nothing external
// can trigger it, so there is no caller to hand an error to.
//
// That panic is only safe where it lands on the activity side of the
// workflow/activity boundary. This must never be called from
// internal/workflows/** — a workflow-side panic fails the *workflow task*,
// which Temporal retries indefinitely by default (this worker leaves
// WorkflowPanicPolicy unset, whose zero value is BlockWorkflow), wedging the
// run rather than failing it. prompts.Decode, this function's only caller, is
// itself only ever invoked from activities.RunStage — see Decode's doc
// comment — and internal/workflows/** is mechanically forbidden from
// importing internal/prompts at all (.golangci.yml's depguard rule), not
// merely by convention. If a future stage's decode needs to run somewhere a
// panic could reach workflow code, it must return an error there instead.
func NewStageOutput(stage Stage, value stageOutputValue) StageOutput {
	if !stageWantsShape(stage, value) {
		panic(fmt.Sprintf("NewStageOutput: %s does not produce a %T", stage, value))
	}
	return StageOutput{stage: stage, value: value}
}

// stageWantsShape reports whether value is the concrete type stage's own
// case in decodeStageOutputValue expects. A switch mirroring that one's
// cases, not calling it directly — decodeStageOutputValue also unmarshals,
// and this only checks shape, at construction, before any JSON is involved.
// Kept beside NewStageOutput rather than merged into decodeStageOutputValue
// so the two remain independently readable: one answers what the wire says,
// the other what the caller just handed it directly.
func stageWantsShape(stage Stage, value stageOutputValue) bool {
	switch stage {
	case StagePlan, StageReview, StageRevise, StagePropose:
		_, ok := value.(DocumentOutput)
		return ok
	case StageImplement:
		_, ok := value.(ImplementOutput)
		return ok
	}
	return false
}

// Stage reports which stage produced this output.
func (o StageOutput) Stage() Stage { return o.stage }

// Prose forwards to the underlying value, or answers "" for a StageOutput
// that has no value yet — the case `prior[stage]` hits for a stage that has
// not run. (A caller checking "is this stage's document available" tests
// Prose() for emptiness, exactly as it tested a zero map value before.)
func (o StageOutput) Prose() string {
	if o.value == nil {
		return ""
	}
	return o.value.Prose()
}

// Value returns the stage-specific output. A caller that does not already
// know o.Stage() is holding this wrong — the map this lives in is keyed by
// Stage for exactly this reason. Type-assert on the type documented for that
// stage.
func (o StageOutput) Value() stageOutputValue { return o.value }

// DocumentOutput is what plan, review, revise and propose each answer in:
// one prose field.
type DocumentOutput struct{ Document string }

// Prose returns the document.
func (d DocumentOutput) Prose() string { return d.Document }

// ImplementOutput is what the implement stage answers in: its report, plus
// whether it finished.
type ImplementOutput struct {
	Report        string
	Blocked       bool
	BlockedReason string
}

// Prose returns the report.
func (o ImplementOutput) Prose() string { return o.Report }

// stageOutputWire is StageOutput's own JSON shape: the stage tag plus the
// value, so UnmarshalJSON can pick the right concrete type back out. Bare
// encoding/json (the converter this codebase's Temporal SDK build uses) can
// not unmarshal into a bare interface value; the tag is what makes that
// possible.
type stageOutputWire struct {
	Stage Stage           `json:"stage"`
	Value json.RawMessage `json:"value"`
}

// MarshalJSON encodes this StageOutput as its stage tag plus its value, so
// UnmarshalJSON can reconstruct the right concrete type on the way back in.
func (o StageOutput) MarshalJSON() ([]byte, error) {
	if o.value == nil {
		return nil, fmt.Errorf("marshalling an empty stage output: NewStageOutput was never called")
	}
	value, err := json.Marshal(o.value)
	if err != nil {
		return nil, fmt.Errorf("marshalling %s output: %w", o.stage, err)
	}
	return json.Marshal(stageOutputWire{Stage: o.stage, Value: value})
}

// UnmarshalJSON decodes a stage tag plus value back into the concrete type
// that stage produces.
func (o *StageOutput) UnmarshalJSON(data []byte) error {
	var wire stageOutputWire
	if err := json.Unmarshal(data, &wire); err != nil {
		return fmt.Errorf("reading a stage output envelope: %w", err)
	}
	value, err := decodeStageOutputValue(wire.Stage, wire.Value)
	if err != nil {
		return err
	}
	o.stage, o.value = wire.Stage, value
	return nil
}

// decodeStageOutputValue is StageOutput's own exhaustive switch — parallel to
// prompts.Decode's, but reading a different wire format for a different
// reason. prompts.Decode reads codex's `--output-schema` answer into a
// StageOutput in the first place; this one reconstructs a StageOutput
// Temporal has already serialized once, on replay. Two switches, not one
// shared function: collapsing them would make Temporal replay depend on
// prompts' codex-facing schema knowledge, which has no reason to be the same
// thing. No default: a sixth stage has to be added here before it compiles,
// matching stageTemplate's own no-default idiom.
//
// A stage tag this switch does not recognise is refused with an explicit
// error rather than silently producing a StageOutput whose value is nil,
// which downstream code would read as "this stage produced nothing".
//
// That is not, on its own, the guard against a run in flight across the deploy
// that ships this step. This method only runs once a "Result" key is present,
// and a pre-this-step activity result has no such key — the field was named
// Document. Renames are caught a level up, by
// activities.RunStageOutput.UnmarshalJSON.
func decodeStageOutputValue(stage Stage, raw json.RawMessage) (stageOutputValue, error) {
	switch stage {
	case StagePlan, StageReview, StageRevise, StagePropose:
		var v DocumentOutput
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, fmt.Errorf("reading %s output: %w", stage, err)
		}
		return v, nil
	case StageImplement:
		var v ImplementOutput
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, fmt.Errorf("reading %s output: %w", stage, err)
		}
		return v, nil
	}
	return nil, fmt.Errorf("no stage output shape for %q", stage)
}
