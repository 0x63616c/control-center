package work

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNewStageOutputRoundTripsThroughJSON(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		stage Stage
		value stageOutputValue
	}{
		{name: "plan", stage: StagePlan, value: DocumentOutput{Document: "the plan"}},
		{name: "review", stage: StageReview, value: DocumentOutput{Document: "the review"}},
		{name: "revise", stage: StageRevise, value: DocumentOutput{Document: "the revised plan"}},
		{name: "propose", stage: StagePropose, value: DocumentOutput{Document: "opened PR #1"}},
		{
			name:  "implement",
			stage: StageImplement,
			value: ImplementOutput{Report: "did the work", Blocked: true, BlockedReason: "needs a human"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			original := NewStageOutput(tc.stage, tc.value)
			data, err := json.Marshal(original)
			if err != nil {
				t.Fatalf("Marshal: %v", err)
			}

			var got StageOutput
			if err := json.Unmarshal(data, &got); err != nil {
				t.Fatalf("Unmarshal: %v", err)
			}
			if got.Stage() != tc.stage {
				t.Errorf("Stage() = %q, want %q", got.Stage(), tc.stage)
			}
			if got.Value() != tc.value {
				t.Errorf("Value() = %#v, want %#v", got.Value(), tc.value)
			}
			if got.Prose() != tc.value.Prose() {
				t.Errorf("Prose() = %q, want %q", got.Prose(), tc.value.Prose())
			}
		})
	}
}

func TestNewStageOutputPanicsOnAMismatchedShape(t *testing.T) {
	t.Parallel()

	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("NewStageOutput(StagePlan, ImplementOutput{...}) did not panic")
		}
		if !strings.Contains(r.(string), "does not produce") {
			t.Errorf("panic value = %v, want it to say the stage does not produce that shape", r)
		}
	}()
	NewStageOutput(StagePlan, ImplementOutput{Report: "x"})
}

func TestZeroStageOutputProseIsEmptyRatherThanPanicking(t *testing.T) {
	t.Parallel()

	var zero StageOutput
	if got := zero.Prose(); got != "" {
		t.Errorf("Prose() of a stage that has not run = %q, want \"\"", got)
	}
}

func TestMarshalJSONRefusesAnEmptyStageOutput(t *testing.T) {
	t.Parallel()

	var zero StageOutput
	if _, err := json.Marshal(zero); err == nil {
		t.Fatal("marshalling a StageOutput with no value succeeded; NewStageOutput was never called")
	}
}

// TestUnmarshalJSONRefusesThePreThisStepShape is the regression guard the
// Migration section of this step's spec depends on: an old, pre-this-step
// RunStageOutput payload — {"Output":...,"Document":"...","ThreadID":...,
// "Usage":{...}}, with no "stage"/"value" keys at all — must fail loudly on
// UnmarshalJSON, not decode into a StageOutput with a nil value. A lenient
// decode here would let a run replaying across this deploy silently forward
// an empty document instead of failing where the mismatch actually is.
func TestUnmarshalJSONRefusesThePreThisStepShape(t *testing.T) {
	t.Parallel()

	oldShape := []byte(`{"Output":"eyJkb2N1bWVudCI6IngifQ==","Document":"x","ThreadID":"thread-1","Usage":{"InputTokens":1}}`)

	var got StageOutput
	err := json.Unmarshal(oldShape, &got)
	if err == nil {
		t.Fatal("UnmarshalJSON accepted the pre-this-step wire shape; want an explicit error")
	}
	if got.Value() != nil {
		t.Errorf("a refused decode left a non-nil value: %#v", got.Value())
	}
}

func TestDecodeStageOutputValueIsExhaustiveOverPipeline(t *testing.T) {
	t.Parallel()

	for _, stage := range Pipeline() {
		t.Run(string(stage), func(t *testing.T) {
			t.Parallel()

			var raw json.RawMessage
			switch stage {
			case StageImplement:
				raw = json.RawMessage(`{"Report":"r","Blocked":false,"BlockedReason":""}`)
			case StagePlan, StageReview, StageRevise, StagePropose:
				raw = json.RawMessage(`{"Document":"d"}`)
			}
			if _, err := decodeStageOutputValue(stage, raw); err != nil {
				t.Fatalf("decodeStageOutputValue(%s): %v", stage, err)
			}
		})
	}
}

func TestDecodeStageOutputValueRefusesAStageOutsideThePipeline(t *testing.T) {
	t.Parallel()

	if _, err := decodeStageOutputValue(Stage("summarise"), json.RawMessage(`{}`)); err == nil {
		t.Fatal("decodeStageOutputValue accepted a stage this pipeline does not have")
	}
}
