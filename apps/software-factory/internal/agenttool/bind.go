package agenttool

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
)

// Result is the provider-neutral outcome of one tool execution.
type Result struct {
	Content string
	IsError bool
}

type boundTool[T any] struct {
	definition Definition[T]
	handler    func(context.Context, T) (Result, error)
}

// Bind couples a definition to a handler accepting the same input type.
func Bind[T any](definition Definition[T], handler func(context.Context, T) (Result, error)) *boundTool[T] {
	return &boundTool[T]{definition: definition, handler: handler}
}

// Specification returns the model-facing tool definition.
func (t *boundTool[T]) Specification() Specification {
	return t.definition.Specification()
}

// Execute decodes provider arguments and invokes the typed handler.
func (t *boundTool[T]) Execute(ctx context.Context, arguments json.RawMessage) (Result, error) {
	var input T
	if err := json.NewDecoder(bytes.NewReader(arguments)).Decode(&input); err != nil {
		return Result{}, fmt.Errorf("decode %q arguments: %w", t.definition.specification.Name, err)
	}
	return t.handler(ctx, input)
}
