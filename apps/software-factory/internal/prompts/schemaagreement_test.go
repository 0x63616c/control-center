package prompts

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// schemaDoc is as much of a stage's JSON Schema as this file compares
// against: the property names it declares, which of them are required, and
// whether it refuses anything else.
type schemaDoc struct {
	AdditionalProperties *bool                `json:"additionalProperties"`
	Required             []string             `json:"required"`
	Properties           map[string]schemaDoc `json:"properties"`
	Items                *schemaDoc           `json:"items"`
}

func readSchema(t *testing.T, file string) schemaDoc {
	t.Helper()

	raw, err := templates.ReadFile(file)
	if err != nil {
		t.Fatalf("reading %s: %v", file, err)
	}
	var doc schemaDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parsing %s: %v", file, err)
	}
	return doc
}

// jsonFields is a struct's json tag names, which is what the decoder will
// accept and nothing more: every envelope here decodes with
// DisallowUnknownFields.
func jsonFields(shape any) []string {
	typ := reflect.TypeOf(shape)
	names := make([]string, 0, typ.NumField())
	for i := range typ.NumField() {
		name, _, _ := strings.Cut(typ.Field(i).Tag.Get("json"), ",")
		if name != "" && name != "-" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

func keys(m map[string]schemaDoc) []string {
	names := make([]string, 0, len(m))
	for name := range m {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// TestEveryStagesSchemaAndDecoderDeclareTheSameFields is the check this
// package's own doc comment promises and did not have: "one JSON Schema and
// one Go decoder per stage, so the writer of a stage's schema and the reader
// of its result cannot drift apart."
//
// Nothing enforced that. A field added to the Go envelope but not the schema
// decodes fine and is simply never populated, because the model was never
// told the field exists — silent, and green. A field added to the schema but
// not the envelope is worse: DisallowUnknownFields turns a model that
// obediently answers with it into a failed stage.
func TestEveryStagesSchemaAndDecoderDeclareTheSameFields(t *testing.T) {
	t.Parallel()

	cases := []struct {
		stage    work.Stage
		envelope any
	}{
		{work.StagePlan, documentEnvelope{}},
		{work.StageImplement, implementEnvelope{}},
		{work.StageReview, reviewEnvelope{}},
	}

	for _, tc := range cases {
		t.Run(string(tc.stage), func(t *testing.T) {
			t.Parallel()

			file, err := stageSchema(tc.stage)
			if err != nil {
				t.Fatalf("stageSchema(%s): %v", tc.stage, err)
			}
			doc := readSchema(t, file)

			if got, want := keys(doc.Properties), jsonFields(tc.envelope); !reflect.DeepEqual(got, want) {
				t.Errorf("%s declares properties %v, decoder accepts %v", file, got, want)
			}
			if doc.AdditionalProperties == nil || *doc.AdditionalProperties {
				t.Errorf("%s does not set additionalProperties:false, but its decoder rejects unknown fields", file)
			}
			for _, name := range doc.Required {
				if _, ok := doc.Properties[name]; !ok {
					t.Errorf("%s requires %q, which it does not declare as a property", file, name)
				}
			}
		})
	}
}

// TestReviewFindingsSchemaAndDecoderDeclareTheSameFields covers the one
// nested shape, which drifts the same way for the same reason.
func TestReviewFindingsSchemaAndDecoderDeclareTheSameFields(t *testing.T) {
	t.Parallel()

	doc := readSchema(t, "templates/review.schema.json")
	findings, ok := doc.Properties["findings"]
	if !ok || findings.Items == nil {
		t.Fatal("review.schema.json declares no findings array with an item shape")
	}

	if got, want := keys(findings.Items.Properties), jsonFields(findingEnvelope{}); !reflect.DeepEqual(got, want) {
		t.Errorf("review.schema.json findings items declare %v, decoder accepts %v", got, want)
	}
	if findings.Items.AdditionalProperties == nil || *findings.Items.AdditionalProperties {
		t.Error("review.schema.json findings items do not set additionalProperties:false")
	}
}

// TestVerifiedIsOptionalInTheReviewSchema pins the one asymmetry on purpose:
// verified carries no control flow, so a turn that omits it must not fail the
// stage. Making it required would turn a whole run red over a field nothing
// branches on. See work.ReviewOutput.Verified.
func TestVerifiedIsOptionalInTheReviewSchema(t *testing.T) {
	t.Parallel()

	doc := readSchema(t, "templates/review.schema.json")
	for _, name := range doc.Required {
		if name == "verified" {
			t.Error("review.schema.json requires verified; it is advisory and must stay optional")
		}
	}
	if _, ok := doc.Properties["verified"]; !ok {
		t.Error("review.schema.json does not declare verified, so no review turn is ever told to answer with it")
	}
}
