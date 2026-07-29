package prompts

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

// envelopeSchema is the JSON Schema every stage's final message is constrained
// to, handed to codex as --output-schema.
//
// It is embedded as its own variable rather than read out of the template
// filesystem by name, so a missing or renamed file is a build failure rather
// than a runtime one.
//
//go:embed templates/envelope.schema.json
var envelopeSchema []byte

// Schema is the envelope every stage answers in.
//
// One field. Everything a machine needs about a stage already exists outside
// it: success or failure from the exit code and the event stream, tokens and
// thread id from work.StageResult, the branch from the harness, the commits and
// diff from git. The pipeline is linear and one-pass, so no stage's output is
// another stage's control flow — which is what would have made a verdict, a
// severity or a file list worth parsing.
//
// The alternative was a typed schema per stage with required fields for plan
// contents, tests and receipts. It was rejected: a required field gets filled
// with something, so it enforces a shape and not a fact, and it puts what a
// plan should contain behind a struct change and a golden regeneration instead
// of a prompt edit. What actually enforces quality here is the review stage and
// the human reading the pull request.
//
// It returns a fresh copy per call, so no caller can edit another's schema.
func Schema() []byte {
	return bytes.Clone(envelopeSchema)
}

// Document reads a stage's document out of the envelope it answered in.
//
// It is strict, and every rejection below is a stage that did not do its job:
// an unreadable result means the stage failed, and the run is worth failing
// visibly rather than carrying an empty or half-guessed document into the next
// prompt. Unknown fields are rejected too — the schema says
// additionalProperties false, and accepting more here would let the two
// disagree quietly.
func Document(result []byte) (string, error) {
	var envelope struct {
		Document *string `json:"document"`
	}

	decoder := json.NewDecoder(bytes.NewReader(result))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return "", fmt.Errorf("reading the stage's result envelope: %w", err)
	}
	// A second value after the envelope means the file holds more than the
	// final message — a stage that appended, or a retry that wrote twice.
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return "", fmt.Errorf("the stage's result holds more than one envelope; only its final message is its output")
	}
	if envelope.Document == nil {
		return "", fmt.Errorf("the stage's result has no document field: it returned something other than the envelope it was given")
	}
	if strings.TrimSpace(*envelope.Document) == "" {
		return "", fmt.Errorf("the stage returned an empty document: it produced no handoff at all")
	}
	return *envelope.Document, nil
}
