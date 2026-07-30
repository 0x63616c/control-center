package prompts

import (
	"strings"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

func TestDocumentReadsAStagesOutput(t *testing.T) {
	t.Parallel()

	got, err := Decode(work.StagePlan, []byte(`{"document":"opened PR #12.\n\nDetail follows."}`))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if want := "opened PR #12.\n\nDetail follows."; got.Prose() != want {
		t.Errorf("Prose() = %q, want %q", got.Prose(), want)
	}
}

func TestDocumentRefusesAnythingButTheEnvelope(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		result string
	}{
		{name: "nothing at all", result: ""},
		{name: "not JSON", result: "here is my plan:"},
		{name: "no document field", result: `{"summary":"did the thing"}`},
		{name: "a null document", result: `{"document":null}`},
		{name: "a document that is not a string", result: `{"document":["a","b"]}`},
		{name: "an empty document", result: `{"document":""}`},
		{name: "a document of whitespace", result: `{"document":"  \n\t "}`},
		{name: "a field the envelope does not have", result: `{"document":"d","verdict":"approve"}`},
		{name: "two envelopes concatenated", result: `{"document":"a"}{"document":"b"}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			// A stage whose output cannot be read is a failed stage. Guessing
			// what it meant is how a confidently wrong PR gets opened.
			if _, err := Decode(work.StagePlan, []byte(tc.result)); err == nil {
				t.Fatalf("Decode accepted %q", tc.result)
			}
		})
	}
}

func TestDocumentSaysWhatItWasGivenWhenItCannotReadIt(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		result string
		want   string
	}{
		{name: "an envelope with no document", result: `{}`, want: "no document field"},
		{
			// It has the field. Saying otherwise sends whoever is debugging
			// the run looking for a schema mismatch that is not there.
			name:   "an envelope whose document is null",
			result: `{"document":null}`,
			want:   "null",
		},
		{name: "an envelope with a field nothing reads", result: `{"document":"d","verdict":"approve"}`, want: "verdict"},
		{name: "a document with nothing in it", result: `{"document":" "}`, want: "empty document"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			_, err := Decode(work.StagePlan, []byte(tc.result))
			if err == nil {
				t.Fatalf("Decode accepted %q", tc.result)
			}
			// The operator reading this at 3am has the error and the
			// transcript, and should not need to go and find the value.
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error %q does not say %q", err, tc.want)
			}
		})
	}
}

func TestImplementReadsAStagesOutput(t *testing.T) {
	t.Parallel()

	got, err := Decode(work.StageImplement, []byte(`{"report":"did the work","blocked":false,"blocked_reason":""}`))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	value, ok := got.Value().(work.ImplementOutput)
	if !ok {
		t.Fatalf("Value() = %T, want work.ImplementOutput", got.Value())
	}
	if value.Report != "did the work" || value.Blocked || value.BlockedReason != "" {
		t.Errorf("got %+v, want an unblocked report", value)
	}
}

func TestImplementCarriesBlockedAndItsReason(t *testing.T) {
	t.Parallel()

	got, err := Decode(work.StageImplement, []byte(`{"report":"could not finish","blocked":true,"blocked_reason":"needs a human decision"}`))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	value := got.Value().(work.ImplementOutput)
	if !value.Blocked || value.BlockedReason != "needs a human decision" {
		t.Errorf("got %+v, want blocked with its reason", value)
	}
}

func TestImplementRefusesAnythingButTheEnvelope(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		result string
	}{
		{name: "nothing at all", result: ""},
		{name: "not JSON", result: "here is my report:"},
		{name: "no report field", result: `{"blocked":false,"blocked_reason":""}`},
		{name: "a null report", result: `{"report":null,"blocked":false,"blocked_reason":""}`},
		{name: "an empty report", result: `{"report":"","blocked":false,"blocked_reason":""}`},
		{name: "no blocked field", result: `{"report":"r","blocked_reason":""}`},
		{name: "no blocked_reason field", result: `{"report":"r","blocked":false}`},
		{name: "blocked true with an empty reason", result: `{"report":"r","blocked":true,"blocked_reason":""}`},
		{name: "blocked false with a non-empty reason", result: `{"report":"r","blocked":false,"blocked_reason":"why"}`},
		{name: "a field the envelope does not have", result: `{"report":"r","blocked":false,"blocked_reason":"","verdict":"approve"}`},
		{name: "two envelopes concatenated", result: `{"report":"a","blocked":false,"blocked_reason":""}{"report":"b","blocked":false,"blocked_reason":""}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			if _, err := Decode(work.StageImplement, []byte(tc.result)); err == nil {
				t.Fatalf("Decode accepted %q", tc.result)
			}
		})
	}
}

// TestDecodeIsExhaustiveOverPipeline calls Decode for every stage of the
// pipeline against a stage-appropriate fixture, so a sixth stage or a
// mis-wired case shows up here rather than only in a caller that happens to
// exercise that one stage.
func TestDecodeIsExhaustiveOverPipeline(t *testing.T) {
	t.Parallel()

	for _, stage := range work.Pipeline() {
		t.Run(string(stage), func(t *testing.T) {
			t.Parallel()

			var fixture string
			if stage == work.StageImplement {
				fixture = `{"report":"r","blocked":false,"blocked_reason":""}`
			} else {
				fixture = `{"document":"d"}`
			}

			got, err := Decode(stage, []byte(fixture))
			if err != nil {
				t.Fatalf("Decode(%s): %v", stage, err)
			}
			if got.Stage() != stage {
				t.Errorf("Stage() = %q, want %q", got.Stage(), stage)
			}
		})
	}
}
