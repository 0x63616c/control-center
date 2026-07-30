package main

import (
	"crypto/rand"
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/prompts"
)

// newPromptRenderer builds the renderer RunStage's prompt is assembled by.
//
// Duplicated from cmd/worker/prompts.go rather than shared: a `package main`
// cannot be imported by another one, and .golangci.yml's entropy-is-injected
// rule denies crypto/rand everywhere except cmd/**, so each composition root
// that needs a renderer constructs its own source. See cmd/worker/prompts.go
// for the fuller rationale (the fence nonce's unforgeability, why this lives
// at a composition root and not in internal/prompts itself).
func newPromptRenderer() (*prompts.Renderer, error) {
	renderer, err := prompts.New(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("building the prompt renderer: %w", err)
	}
	return renderer, nil
}
