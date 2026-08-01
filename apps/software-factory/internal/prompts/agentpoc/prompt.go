// Package agentpoc owns the static prompt and tool schema for the local POC.
package agentpoc

import (
	_ "embed"
	"encoding/json"
)

//go:embed instructions.md
var instructions string

//go:embed tool.schema.json
var toolSchema []byte

// Instructions returns the model's static system instructions.
func Instructions() string { return instructions }

// ToolSchema returns a copy of the tool's JSON Schema.
func ToolSchema() json.RawMessage { return append(json.RawMessage(nil), toolSchema...) }
