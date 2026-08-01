package main

import (
	"bytes"
	"context"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

func TestProjectedSecretRedactorReadsCurrentProjectedMaterialAndRedactsOnlyExactValues(t *testing.T) {
	files := map[string][]byte{
		work.RunWorkerGitHubTokenFile:          []byte("github-token-one"),
		work.RunWorkerCodexCredentialFile:      []byte(`{"tokens":{"access_token":"codex-access-token","refresh_token":"","id_token":"codex-id-token"},"OPENAI_API_KEY":"openai-api-key"}`),
		work.RunWorkerCheckpointCapabilityFile: []byte("checkpoint-capability"),
		work.RunWorkerRepositoryCapabilityFile: []byte("repository-capability"),
	}
	redactor, err := newProjectedSecretRedactor(func(path string) ([]byte, error) {
		return bytes.Clone(files[path]), nil
	})
	if err != nil {
		t.Fatalf("newProjectedSecretRedactor: %v", err)
	}

	secrets := [][]byte{
		[]byte("github-token-one"), []byte("codex-access-token"), []byte("codex-id-token"), []byte("openai-api-key"),
		[]byte("checkpoint-capability"), []byte("repository-capability"),
	}
	raw := bytes.Join(secrets, []byte(" | "))
	got, err := redactor.Redact(context.Background(), raw)
	if err != nil {
		t.Fatalf("Redact: %v", err)
	}
	for _, secret := range secrets {
		if bytes.Contains(got, secret) {
			t.Fatalf("redacted output leaked %q: %s", secret, got)
		}
	}

	files[work.RunWorkerGitHubTokenFile] = []byte("github-token-two")
	got, err = redactor.Redact(context.Background(), []byte("github-token-one github-token-two"))
	if err != nil {
		t.Fatalf("Redact after rotation: %v", err)
	}
	if bytes.Contains(got, []byte("github-token-one")) || bytes.Contains(got, []byte("github-token-two")) {
		t.Fatalf("redacted rotated token leaked: %s", got)
	}
}
