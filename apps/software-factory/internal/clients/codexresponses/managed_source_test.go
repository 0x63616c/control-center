package codexresponses

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

type fakeCredentialFileSource struct {
	file work.CredentialFile
	err  error
}

func (f fakeCredentialFileSource) SandboxCredentialFile(context.Context) (work.CredentialFile, error) {
	return f.file, f.err
}

func TestManagedCredentialSourceExtractsTheDirectCallCredential(t *testing.T) {
	t.Parallel()

	document, err := json.Marshal(map[string]any{"tokens": map[string]any{
		"access_token":  "access-value",
		"refresh_token": "",
		"account_id":    "account-123",
	}})
	if err != nil {
		t.Fatalf("encoding credential document: %v", err)
	}
	source, err := NewManagedCredentialSource(fakeCredentialFileSource{file: work.NewCredentialFile(document)})
	if err != nil {
		t.Fatalf("constructing source: %v", err)
	}

	credential, err := source.Credential(context.Background())
	if err != nil {
		t.Fatalf("loading credential: %v", err)
	}
	if credential.AccessToken.Reveal() != "access-value" || credential.AccountID != "account-123" {
		t.Fatalf("credential = %#v", credential)
	}
}

func TestManagedCredentialSourceWrapsItsDependencyErrorWithoutLeakingValues(t *testing.T) {
	t.Parallel()

	const secret = "do-not-leak"
	source, err := NewManagedCredentialSource(fakeCredentialFileSource{err: errors.New("unavailable")})
	if err != nil {
		t.Fatalf("constructing source: %v", err)
	}
	_, err = source.Credential(context.Background())
	if err == nil || strings.Contains(err.Error(), secret) {
		t.Fatalf("error = %v", err)
	}
}
