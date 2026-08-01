package codexresponses

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codexauth"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock/clocktest"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

type fakeRefresher struct {
	result  codexauth.Refreshed
	outcome codexauth.RefreshOutcome
	err     error
	seen    work.Credential
	calls   int
}

func (f *fakeRefresher) Refresh(_ context.Context, token work.Credential) (codexauth.Refreshed, codexauth.RefreshOutcome, error) {
	f.calls++
	f.seen = token
	return f.result, f.outcome, f.err
}

func TestFileCredentialSourceNeverReplaysARefreshWithUnknownOutcome(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.July, 31, 12, 0, 0, 0, time.UTC)
	path := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(path, credentialDocument(t, jwt(t, now.Add(time.Minute)), "single-use-refresh", "account-123", nil), 0o600); err != nil {
		t.Fatalf("writing seed: %v", err)
	}
	refresher := &fakeRefresher{outcome: codexauth.RefreshUnknown, err: errors.New("response was lost")}
	source, err := NewFileCredentialSource(path, refresher, clocktest.NewFake(now), 5*time.Minute)
	if err != nil {
		t.Fatalf("constructing source: %v", err)
	}

	for attempt := 1; attempt <= 2; attempt++ {
		if _, err := source.Credential(context.Background()); !errors.Is(err, codexauth.ErrRefreshOutcomeUnknown) {
			t.Fatalf("attempt %d error = %v, want ErrRefreshOutcomeUnknown", attempt, err)
		}
	}
	if refresher.calls != 1 {
		t.Fatalf("refresh calls = %d, want 1", refresher.calls)
	}
}

func TestFileCredentialSourceMayRetryARefreshThatWasNotSent(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.July, 31, 12, 0, 0, 0, time.UTC)
	path := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(path, credentialDocument(t, jwt(t, now.Add(time.Minute)), "retryable-refresh", "account-123", nil), 0o600); err != nil {
		t.Fatalf("writing seed: %v", err)
	}
	refresher := &fakeRefresher{outcome: codexauth.RefreshNotSent, err: errors.New("dial failed before write")}
	source, err := NewFileCredentialSource(path, refresher, clocktest.NewFake(now), 5*time.Minute)
	if err != nil {
		t.Fatalf("constructing source: %v", err)
	}

	for attempt := 1; attempt <= 2; attempt++ {
		if _, err := source.Credential(context.Background()); err == nil {
			t.Fatalf("attempt %d unexpectedly succeeded", attempt)
		}
	}
	if refresher.calls != 2 {
		t.Fatalf("refresh calls = %d, want 2", refresher.calls)
	}
}

func TestFileCredentialSourceRefreshesAndPersistsTheWritableRuntimeCopy(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.July, 31, 12, 0, 0, 0, time.UTC)
	path := filepath.Join(t.TempDir(), "auth.json")
	seed := credentialDocument(t, jwt(t, now.Add(time.Minute)), "old-refresh", "account-123", map[string]any{"preserved": true})
	if err := os.WriteFile(path, seed, 0o600); err != nil {
		t.Fatalf("writing seed: %v", err)
	}

	refresher := &fakeRefresher{
		result: codexauth.Refreshed{
			AccessToken:  work.NewCredential(jwt(t, now.Add(2*time.Hour))),
			RefreshToken: work.NewCredential("new-refresh"),
		},
		outcome: codexauth.RefreshRotated,
	}
	source, err := NewFileCredentialSource(path, refresher, clocktest.NewFake(now), 5*time.Minute)
	if err != nil {
		t.Fatalf("constructing source: %v", err)
	}

	credential, err := source.Credential(context.Background())
	if err != nil {
		t.Fatalf("loading credential: %v", err)
	}
	if credential.AccountID != "account-123" || credential.AccessToken.Reveal() != refresher.result.AccessToken.Reveal() {
		t.Fatalf("credential = %#v", credential)
	}
	if refresher.seen.Reveal() != "old-refresh" {
		t.Fatal("refresher did not receive the stored refresh token")
	}

	stored, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading rotated file: %v", err)
	}
	var document map[string]any
	if err := json.Unmarshal(stored, &document); err != nil {
		t.Fatalf("decoding rotated file: %v", err)
	}
	if document["preserved"] != true {
		t.Fatalf("unmodelled field was not preserved: %#v", document)
	}
	tokens := document["tokens"].(map[string]any)
	if tokens["refresh_token"] != "new-refresh" {
		t.Fatalf("refresh token was not rotated: %#v", tokens)
	}
}

func TestFileCredentialSourceErrorsNeverContainCredentialValues(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "auth.json")
	const secret = "do-not-leak-this-token"
	if err := os.WriteFile(path, credentialDocument(t, "not-a-jwt", secret, "account-123", nil), 0o600); err != nil {
		t.Fatalf("writing seed: %v", err)
	}
	source, err := NewFileCredentialSource(path, &fakeRefresher{}, clocktest.NewFake(time.Date(2026, time.July, 31, 12, 0, 0, 0, time.UTC)), time.Minute)
	if err != nil {
		t.Fatalf("constructing source: %v", err)
	}
	_, err = source.Credential(context.Background())
	if err == nil {
		t.Fatal("loading malformed credential succeeded")
	}
	if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "not-a-jwt") {
		t.Fatalf("error leaked credential material: %v", err)
	}
}

func credentialDocument(t *testing.T, access, refresh, account string, extra map[string]any) []byte {
	t.Helper()
	document := map[string]any{
		"auth_mode": "chatgpt",
		"tokens": map[string]any{
			"access_token":  access,
			"refresh_token": refresh,
			"account_id":    account,
		},
	}
	for key, value := range extra {
		document[key] = value
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("encoding credential: %v", err)
	}
	return encoded
}

func jwt(t *testing.T, expires time.Time) string {
	t.Helper()
	payload, err := json.Marshal(map[string]int64{"exp": expires.Unix()})
	if err != nil {
		t.Fatalf("encoding JWT: %v", err)
	}
	encode := base64.RawURLEncoding.EncodeToString
	return encode([]byte(`{"alg":"none"}`)) + "." + encode(payload) + ".signature"
}
