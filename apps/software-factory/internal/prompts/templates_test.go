package prompts

import (
	"strings"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

func TestInterpolateFillsPlaceholdersInPlace(t *testing.T) {
	t.Parallel()

	got, err := interpolate("issue #{{n}}: {{title}}\n{{n}} again", map[string]string{"n": "329", "title": "prompts"})
	if err != nil {
		t.Fatalf("interpolate: %v", err)
	}
	if want := "issue #329: prompts\n329 again"; got != want {
		t.Errorf("interpolate = %q, want %q", got, want)
	}
}

func TestInterpolateIsStrictInBothDirections(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		template string
		values   map[string]string
	}{
		{
			// The failure this prevents is the literal text `{{ticket_body}}`
			// reaching a model as if it were the issue.
			name:     "the template asks for something the stage has no value for",
			template: "read {{ticket_body}}",
			values:   map[string]string{},
		},
		{
			// And this one is the same edit from the other side: a variable
			// renamed in the markdown, its value now silently dropped.
			name:     "the stage has a value the template never asks for",
			template: "read the issue",
			values:   map[string]string{"ticket_body": "b"},
		},
		{
			name:     "a placeholder that is never closed",
			template: "read {{ticket_body",
			values:   map[string]string{"ticket_body": "b"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			if _, err := interpolate(tc.template, tc.values); err == nil {
				t.Fatal("interpolate accepted a template and values that do not match")
			}
		})
	}
}

func TestInterpolateNeverRescansWhatItSubstituted(t *testing.T) {
	t.Parallel()

	// The value here is issue text. If substitution were recursive, an issue
	// body could name a variable and choose what goes into its own prompt.
	got, err := interpolate("{{body}}", map[string]string{"body": "{{fence_nonce}}"})
	if err != nil {
		t.Fatalf("interpolate: %v", err)
	}
	if want := "{{fence_nonce}}"; got != want {
		t.Errorf("interpolate = %q, want %q", got, want)
	}
}

func TestEveryStageHasAPromptAndTheyAreDistinct(t *testing.T) {
	t.Parallel()

	seen := map[string]work.Stage{}
	for _, stage := range work.Pipeline() {
		file, err := stageTemplate(stage)
		if err != nil {
			t.Fatalf("stageTemplate(%s): %v", stage, err)
		}
		if other, ok := seen[file]; ok {
			t.Errorf("stages %s and %s share the prompt %s", stage, other, file)
		}
		seen[file] = stage

		body, err := templates.ReadFile(file)
		if err != nil {
			t.Fatalf("the prompt for %s is not embedded: %v", stage, err)
		}
		if want := "## Stage: " + string(stage); !strings.Contains(string(body), want) {
			t.Errorf("%s does not open with %q", file, want)
		}
	}
}

func TestBaseFencesTheIssueTextWithTheRunsNonce(t *testing.T) {
	t.Parallel()

	base, err := templates.ReadFile(baseTemplate)
	if err != nil {
		t.Fatalf("reading %s: %v", baseTemplate, err)
	}

	// Two tags, one nonce placeholder each. A base that opened the fence and
	// forgot to close it would leave every issue's text un-fenced.
	if got := strings.Count(string(base), "{{fence_nonce}}"); got != 2 {
		t.Errorf("%s carries %d fence nonce placeholders, want 2", baseTemplate, got)
	}
	// The stage's own instructions come after the fence closes, so untrusted
	// text is never the last thing the model reads.
	if strings.Index(string(base), "</"+fenceTag) > strings.Index(string(base), "Your instructions for this stage follow") {
		t.Error("the fence closes after the base hands over to the stage prompt")
	}
}

func TestDocumentVarNamesEachStagesOutputAsThatStageDoes(t *testing.T) {
	t.Parallel()

	cases := []struct {
		produced work.Stage
		want     string
	}{
		{produced: work.StagePlan, want: "plan"},
		{produced: work.StageReview, want: "review"},
		{produced: work.StageRevise, want: "revised_plan"},
		{produced: work.StageImplement, want: "implementation_report"},
	}

	for _, tc := range cases {
		got, err := documentVar(tc.produced)
		if err != nil {
			t.Fatalf("documentVar(%s): %v", tc.produced, err)
		}
		if got != tc.want {
			t.Errorf("documentVar(%s) = %q, want %q", tc.produced, got, tc.want)
		}
	}

	// Nothing follows propose, so asking for its variable is a bug in the
	// caller rather than a name we have not chosen yet.
	if _, err := documentVar(work.StagePropose); err == nil {
		t.Error("documentVar(propose) returned a name; no stage reads the proposal")
	}
}
