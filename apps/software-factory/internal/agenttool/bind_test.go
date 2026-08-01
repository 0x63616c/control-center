package agenttool_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agenttool"
)

func TestBindDecodesAndExecutesTheTypedInput(t *testing.T) {
	t.Parallel()

	definition := agenttool.Define[readInput](
		"read_file",
		"Read a bounded region of a repository file.",
	)
	tool := agenttool.Bind(definition, func(_ context.Context, input readInput) (agenttool.Result, error) {
		if input.Path != "docs/design.md" || input.Limit != 512 {
			t.Fatalf("input = %#v", input)
		}
		return agenttool.Result{Content: "design"}, nil
	})

	result, err := tool.Execute(context.Background(), json.RawMessage(`{"path":"docs/design.md","limit":512}`))
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if result.Content != "design" || result.IsError {
		t.Fatalf("result = %#v", result)
	}
}
