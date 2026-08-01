package agenttool

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
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

type semanticValidator interface {
	Validate() error
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
	var value any
	if err := json.Unmarshal(arguments, &value); err != nil {
		return Result{Content: fmt.Sprintf("invalid arguments: %v", err), IsError: true}, nil
	}
	if err := t.definition.validator.Validate(value); err != nil {
		return Result{Content: fmt.Sprintf("invalid arguments: %v", err), IsError: true}, nil
	}

	var input T
	decoder := json.NewDecoder(bytes.NewReader(arguments))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return Result{Content: fmt.Sprintf("invalid arguments: %v", err), IsError: true}, nil
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			err = fmt.Errorf("more than one JSON value")
		}
		return Result{Content: fmt.Sprintf("invalid arguments: %v", err), IsError: true}, nil
	}
	if validator, ok := any(input).(semanticValidator); ok {
		if err := validator.Validate(); err != nil {
			return Result{Content: fmt.Sprintf("invalid arguments: %v", err), IsError: true}, nil
		}
	} else if validator, ok := any(&input).(semanticValidator); ok {
		if err := validator.Validate(); err != nil {
			return Result{Content: fmt.Sprintf("invalid arguments: %v", err), IsError: true}, nil
		}
	}
	return t.handler(ctx, input)
}
