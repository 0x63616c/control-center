package prompts

import (
	"strings"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// TestActivityRendererMatchesTheUnderlyingRenderer proves the adapter forwards
// rather than diverges: what it renders is what Renderer.Render would have
// rendered for the same Input, and the schema is the one every stage answers
// in.
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
	if string(schema) != string(Schema()) {
		t.Errorf("Render schema does not match Schema()")
	}
}

// TestActivityRendererDocumentForwardsToThePackageFunction proves Document
// is not reimplemented, only exposed as a method.
func TestActivityRendererDocumentForwardsToThePackageFunction(t *testing.T) {
	t.Parallel()

	adapter := NewActivityRenderer(newTestRenderer(t))
	result := []byte(`{"document":"the handoff"}`)

	got, err := adapter.Document(result)
	if err != nil {
		t.Fatalf("Document: %v", err)
	}
	want, err := Document(result)
	if err != nil {
		t.Fatalf("Document: %v", err)
	}
	if got != want {
		t.Errorf("adapter.Document = %q, want %q", got, want)
	}
}

// TestActivityRendererFailsLikeTheRendererItWraps proves an error from
// Renderer.Render is not swallowed or replaced.
func TestActivityRendererFailsLikeTheRendererItWraps(t *testing.T) {
	t.Parallel()

	adapter := NewActivityRenderer(newTestRenderer(t))
	_, _, err := adapter.Render(work.StagePlan, work.TicketDetail{}, nil)
	if err == nil {
		t.Fatal("Render with an empty ticket detail: want an error, got nil")
	}
}
