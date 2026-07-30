package prompts

import (
	"strings"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// TestActivityRendererMatchesTheUnderlyingRenderer proves the adapter forwards
// rather than diverges: what it renders is what Renderer.Render would have
// rendered for the same Input, and the schema is that stage's own.
func TestActivityRendererMatchesTheUnderlyingRenderer(t *testing.T) {
	t.Parallel()

	renderer := newTestRenderer(t)
	adapter := NewActivityRenderer(renderer)

	stage := work.StagePlan
	detail := ticket()
	prior := everyDocument()

	prompt, schema, err := adapter.Render(stage, detail, prior)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if !strings.Contains(prompt, detail.Title) {
		t.Errorf("Render prompt does not contain the ticket title %q", detail.Title)
	}
	want, err := templates.ReadFile("templates/plan.schema.json")
	if err != nil {
		t.Fatalf("reading templates/plan.schema.json: %v", err)
	}
	if string(schema) != string(want) {
		t.Errorf("Render schema does not match plan's own schema file")
	}
}

// TestActivityRendererSchemaMatchesEachStagesOwnFile is the falsifiable
// per-stage wiring check: every stage's rendered schema is byte-identical to
// that stage's own embedded file, and implement's is not byte-identical to
// plan's. A stage-blind lookup (e.g. always returning plan's schema) would
// still pass TestActivityRendererMatchesTheUnderlyingRenderer above, because
// that test only exercises one stage — this one would catch it.
func TestActivityRendererSchemaMatchesEachStagesOwnFile(t *testing.T) {
	t.Parallel()

	adapter := NewActivityRenderer(newTestRenderer(t))
	detail := ticket()
	prior := everyDocument()

	schemas := map[work.Stage][]byte{}
	for _, stage := range work.Pipeline() {
		file, err := stageSchema(stage)
		if err != nil {
			t.Fatalf("stageSchema(%s): %v", stage, err)
		}
		want, err := templates.ReadFile(file)
		if err != nil {
			t.Fatalf("reading %s: %v", file, err)
		}

		_, schema, err := adapter.Render(stage, detail, prior)
		if err != nil {
			t.Fatalf("Render(%s): %v", stage, err)
		}
		if string(schema) != string(want) {
			t.Errorf("Render(%s) schema does not match %s", stage, file)
		}
		schemas[stage] = schema
	}

	if string(schemas[work.StageImplement]) == string(schemas[work.StagePlan]) {
		t.Error("implement's schema is byte-identical to plan's; the per-stage lookup is not actually per-stage")
	}
}

// TestActivityRendererDecodeForwardsToThePackageFunction proves Decode is
// not reimplemented, only exposed as a method.
func TestActivityRendererDecodeForwardsToThePackageFunction(t *testing.T) {
	t.Parallel()

	adapter := NewActivityRenderer(newTestRenderer(t))
	result := []byte(`{"document":"the handoff"}`)

	got, err := adapter.Decode(work.StagePlan, result)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	want, err := Decode(work.StagePlan, result)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if got != want {
		t.Errorf("adapter.Decode = %#v, want %#v", got, want)
	}
}

// TestActivityRendererFailsLikeTheRendererItWraps proves an error from
// Renderer.Render is not swallowed or replaced.
func TestActivityRendererFailsLikeTheRendererItWraps(t *testing.T) {
	t.Parallel()

	adapter := NewActivityRenderer(newTestRenderer(t))
	_, _, err := adapter.Render(work.StagePlan, work.TicketDetail{}, work.PriorTurns{})
	if err == nil {
		t.Fatal("Render with an empty ticket detail: want an error, got nil")
	}
}
