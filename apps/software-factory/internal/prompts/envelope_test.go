package prompts

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSchemaIsTheOneFieldEnvelope(t *testing.T) {
	t.Parallel()

	var got struct {
		Type                 string `json:"type"`
		AdditionalProperties *bool  `json:"additionalProperties"`
		Required             []string
		Properties           map[string]struct {
			Type string `json:"type"`
		}
	}
	if err := json.Unmarshal(Schema(), &got); err != nil {
		t.Fatalf("the schema is not valid JSON: %v", err)
	}

	// The envelope is transport and the prompt is content: one markdown field,
	// nothing a stage could be made to fill in with something plausible.
	switch {
	case got.Type != "object":
		t.Errorf("schema type = %q, want object", got.Type)
	case len(got.Properties) != 1:
		t.Errorf("the envelope has %d properties, want 1", len(got.Properties))
	case got.Properties["document"].Type != "string":
		t.Errorf("document type = %q, want string", got.Properties["document"].Type)
	case len(got.Required) != 1 || got.Required[0] != "document":
		t.Errorf("required = %v, want [document]", got.Required)
	case got.AdditionalProperties == nil || *got.AdditionalProperties:
		t.Error("additionalProperties is not false, so a stage may return fields nothing reads")
	}
}

func TestSchemaHandsOutACopy(t *testing.T) {
	t.Parallel()

	first := Schema()
	first[0] = 'x'
	if Schema()[0] == 'x' {
		t.Error("one caller's edit reached every other caller's schema")
	}
}

func TestDocumentReadsAStagesOutput(t *testing.T) {
	t.Parallel()

	got, err := Document([]byte(`{"document":"opened PR #12.\n\nDetail follows."}`))
	if err != nil {
		t.Fatalf("Document: %v", err)
	}
	if want := "opened PR #12.\n\nDetail follows."; got != want {
		t.Errorf("Document = %q, want %q", got, want)
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
			if _, err := Document([]byte(tc.result)); err == nil {
				t.Fatalf("Document accepted %q", tc.result)
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
		{name: "an envelope with no document", result: `{}`, want: "document"},
		{name: "an envelope with a field nothing reads", result: `{"document":"d","verdict":"approve"}`, want: "verdict"},
		{name: "a document with nothing in it", result: `{"document":" "}`, want: "empty document"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			_, err := Document([]byte(tc.result))
			if err == nil {
				t.Fatalf("Document accepted %q", tc.result)
			}
			// The operator reading this at 3am has the error and the
			// transcript, and should not need to go and find the value.
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error %q does not say %q", err, tc.want)
			}
		})
	}
}
