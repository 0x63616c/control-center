// Package agenttool defines typed tools exposed to an agent.
package agenttool

import (
	"encoding/json"
	"fmt"

	"github.com/invopop/jsonschema"
)

// Specification is the model-facing definition of a tool.
type Specification struct {
	Name        string
	Description string
	Parameters  json.RawMessage
}

// Definition binds a tool name and description to one Go input type.
type Definition[T any] struct {
	specification Specification
}

// Define derives a strict JSON schema from T once at construction time.
func Define[T any](name, description string) Definition[T] {
	reflector := jsonschema.Reflector{
		Anonymous:      true,
		DoNotReference: true,
	}
	var input T
	schema := reflector.Reflect(input)
	schema.Version = ""
	schemaJSON, err := json.Marshal(schema)
	if err != nil {
		panic(fmt.Sprintf("agenttool: marshal schema for %q: %v", name, err))
	}

	return Definition[T]{
		specification: Specification{
			Name:        name,
			Description: description,
			Parameters:  schemaJSON,
		},
	}
}

// Specification returns the immutable model-facing tool definition.
func (d Definition[T]) Specification() Specification {
	return Specification{
		Name:        d.specification.Name,
		Description: d.specification.Description,
		Parameters:  append(json.RawMessage(nil), d.specification.Parameters...),
	}
}
