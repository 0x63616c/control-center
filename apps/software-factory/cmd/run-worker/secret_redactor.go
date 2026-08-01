package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

const redactedSecret = "[redacted]"

// projectedSecretRedactor reads the current projected files immediately before
// durable agent evidence is written. It only replaces exact material from
// those files; it does not guess at credential-shaped text.
type projectedSecretRedactor struct {
	readFile func(string) ([]byte, error)
	paths    projectedSecretPaths

	mu       sync.Mutex
	observed [][]byte
}

type projectedSecretPaths struct {
	GitHubToken          string
	CodexAuth            string
	CheckpointCapability string
	RepositoryCapability string
}

func newProjectedSecretRedactor(readFile func(string) ([]byte, error)) (*projectedSecretRedactor, error) {
	if readFile == nil {
		return nil, fmt.Errorf("building projected secret redactor: file reader is required")
	}
	return &projectedSecretRedactor{
		readFile: readFile,
		paths: projectedSecretPaths{
			GitHubToken:          work.RunWorkerGitHubTokenFile,
			CodexAuth:            work.RunWorkerCodexCredentialFile,
			CheckpointCapability: work.RunWorkerCheckpointCapabilityFile,
			RepositoryCapability: work.RunWorkerRepositoryCapabilityFile,
		},
	}, nil
}

// Prime snapshots the current projected material before provider execution.
// Values remain in the process-local set after a projected credential rotation
// because the agent may emit an older token after the projection has changed.
func (r *projectedSecretRedactor) Prime(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("reading projected secret material: %w", err)
	}
	current, err := r.currentValues()
	if err != nil {
		return err
	}
	r.mu.Lock()
	r.observed = appendSecretValues(r.observed, current)
	r.mu.Unlock()
	return nil
}

// Redact removes exact observed secret values from untrusted agent output
// without logging either the source material or the output.
func (r *projectedSecretRedactor) Redact(ctx context.Context, raw []byte) ([]byte, error) {
	if err := r.Prime(ctx); err != nil {
		return nil, err
	}
	r.mu.Lock()
	values := cloneSecretValues(r.observed)
	r.mu.Unlock()
	redacted := bytes.Clone(raw)
	for _, value := range values {
		redacted = bytes.ReplaceAll(redacted, value, []byte(redactedSecret))
	}
	return redacted, nil
}

func (r *projectedSecretRedactor) currentValues() ([][]byte, error) {
	githubToken, err := r.readFile(r.paths.GitHubToken)
	if err != nil {
		return nil, fmt.Errorf("reading projected GitHub token: %w", err)
	}
	codexAuth, err := r.readFile(r.paths.CodexAuth)
	if err != nil {
		return nil, fmt.Errorf("reading projected Codex auth: %w", err)
	}
	checkpointCapability, err := r.readFile(r.paths.CheckpointCapability)
	if err != nil {
		return nil, fmt.Errorf("reading projected checkpoint capability: %w", err)
	}
	repositoryCapability, err := r.readFile(r.paths.RepositoryCapability)
	if err != nil {
		return nil, fmt.Errorf("reading projected repository capability: %w", err)
	}

	var auth struct {
		Tokens struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			IDToken      string `json:"id_token"`
		} `json:"tokens"`
		OpenAIAPIKey *string `json:"OPENAI_API_KEY"`
	}
	if err := json.Unmarshal(codexAuth, &auth); err != nil {
		return nil, fmt.Errorf("reading projected Codex auth: invalid document")
	}

	values := [][]byte{
		bytes.TrimSpace(githubToken),
		codexAuth,
		[]byte(auth.Tokens.AccessToken),
		[]byte(auth.Tokens.RefreshToken),
		[]byte(auth.Tokens.IDToken),
		bytes.TrimSpace(checkpointCapability),
		bytes.TrimSpace(repositoryCapability),
	}
	if auth.OpenAIAPIKey != nil {
		values = append(values, []byte(*auth.OpenAIAPIKey))
	}
	return nonEmptyUniqueSecretValues(values), nil
}

func nonEmptyUniqueSecretValues(values [][]byte) [][]byte {
	seen := make(map[string]struct{}, len(values))
	result := make([][]byte, 0, len(values))
	for _, value := range values {
		if len(value) == 0 || strings.TrimSpace(string(value)) == "" {
			continue
		}
		key := string(value)
		if _, found := seen[key]; found {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, bytes.Clone(value))
	}
	return result
}

func appendSecretValues(existing, current [][]byte) [][]byte {
	values := make([][]byte, 0, len(existing)+len(current))
	values = append(values, existing...)
	values = append(values, current...)
	return nonEmptyUniqueSecretValues(values)
}

func cloneSecretValues(values [][]byte) [][]byte {
	cloned := make([][]byte, 0, len(values))
	for _, value := range values {
		cloned = append(cloned, bytes.Clone(value))
	}
	return cloned
}

var _ interface {
	Prime(context.Context) error
	Redact(context.Context, []byte) ([]byte, error)
} = (*projectedSecretRedactor)(nil)
