package codexresponses

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codexauth"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

const (
	tokensKey       = "tokens"
	accessTokenKey  = "access_token"
	refreshTokenKey = "refresh_token"
	accountIDKey    = "account_id"
	lastRefreshKey  = "last_refresh"
)

// FileCredentialSource owns one writable runtime copy of Codex's auth.json.
//
// It is intentionally a single-process mechanism for the local POC. The mutex
// prevents concurrent activities in the sole worker from presenting the same
// rotating refresh token. A multi-worker deployment must use the leased
// Kubernetes Secret source in codexauth instead.
type FileCredentialSource struct {
	path      string
	refresher codexauth.TokenRefresher
	clock     clock.Clock
	margin    time.Duration
	mu        sync.Mutex
}

// NewFileCredentialSource constructs a source for an explicitly selected file.
func NewFileCredentialSource(
	path string,
	refresher codexauth.TokenRefresher,
	clk clock.Clock,
	margin time.Duration,
) (*FileCredentialSource, error) {
	switch {
	case path == "":
		return nil, fmt.Errorf("a Codex file credential source needs an explicit path")
	case refresher == nil:
		return nil, fmt.Errorf("a Codex file credential source needs a token refresher")
	case clk == nil:
		return nil, fmt.Errorf("a Codex file credential source needs a clock")
	case margin <= 0:
		return nil, fmt.Errorf("a Codex file credential source needs a positive refresh margin")
	}
	return &FileCredentialSource{path: path, refresher: refresher, clock: clk, margin: margin}, nil
}

// Credential returns a usable access token and account, refreshing atomically
// when the access token is inside the configured margin.
func (s *FileCredentialSource) Credential(ctx context.Context) (Credential, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	document, err := readCredentialDocument(s.path)
	if err != nil {
		return Credential{}, err
	}
	expires, err := accessTokenExpiry(document.access)
	if err != nil {
		return Credential{}, fmt.Errorf("reading the Codex access-token expiry: %w", err)
	}
	if s.clock.Now().Add(s.margin).Before(expires) {
		return document.credential(), nil
	}

	rotated, outcome, err := s.refresher.Refresh(ctx, document.refresh)
	if err != nil {
		return Credential{}, fmt.Errorf("refreshing the Codex credential (%s): %w", outcome, err)
	}
	if outcome != codexauth.RefreshRotated {
		return Credential{}, fmt.Errorf("refreshing the Codex credential ended with outcome %s", outcome)
	}
	if rotated.AccessToken.Reveal() != "" {
		document.access = rotated.AccessToken
	}
	if rotated.RefreshToken.Reveal() != "" {
		document.refresh = rotated.RefreshToken
	}
	if document.access.Reveal() == "" || document.refresh.Reveal() == "" {
		return Credential{}, fmt.Errorf("the rotated Codex credential is incomplete")
	}
	if err := document.applyRotation(s.clock.Now()); err != nil {
		return Credential{}, err
	}
	if err := writeCredentialDocument(s.path, document.raw); err != nil {
		return Credential{}, err
	}
	return document.credential(), nil
}

type fileCredentialDocument struct {
	raw     map[string]json.RawMessage
	tokens  map[string]json.RawMessage
	access  work.Credential
	refresh work.Credential
	account string
}

func readCredentialDocument(path string) (fileCredentialDocument, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return fileCredentialDocument{}, fmt.Errorf("reading the configured Codex credential file: %w", err)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return fileCredentialDocument{}, fmt.Errorf("the configured Codex credential file is not a JSON object")
	}
	var tokens map[string]json.RawMessage
	if err := json.Unmarshal(raw[tokensKey], &tokens); err != nil {
		return fileCredentialDocument{}, fmt.Errorf("the configured Codex credential file has no usable tokens object")
	}
	access, err := requiredString(tokens, accessTokenKey)
	if err != nil {
		return fileCredentialDocument{}, err
	}
	refresh, err := requiredString(tokens, refreshTokenKey)
	if err != nil {
		return fileCredentialDocument{}, err
	}
	account, err := requiredString(tokens, accountIDKey)
	if err != nil {
		return fileCredentialDocument{}, err
	}
	return fileCredentialDocument{
		raw: raw, tokens: tokens,
		access: work.NewCredential(access), refresh: work.NewCredential(refresh), account: account,
	}, nil
}

func requiredString(values map[string]json.RawMessage, key string) (string, error) {
	var value string
	if err := json.Unmarshal(values[key], &value); err != nil || value == "" {
		return "", fmt.Errorf("the configured Codex credential has no usable %s field", key)
	}
	return value, nil
}

func (d *fileCredentialDocument) applyRotation(now time.Time) error {
	for key, value := range map[string]string{
		accessTokenKey:  d.access.Reveal(),
		refreshTokenKey: d.refresh.Reveal(),
	} {
		encoded, err := json.Marshal(value)
		if err != nil {
			return fmt.Errorf("encoding the rotated Codex %s field: %w", key, err)
		}
		d.tokens[key] = encoded
	}
	encodedTokens, err := json.Marshal(d.tokens)
	if err != nil {
		return fmt.Errorf("encoding the rotated Codex tokens object: %w", err)
	}
	d.raw[tokensKey] = encodedTokens
	encodedTime, err := json.Marshal(now.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return fmt.Errorf("encoding the Codex refresh timestamp: %w", err)
	}
	d.raw[lastRefreshKey] = encodedTime
	return nil
}

func (d fileCredentialDocument) credential() Credential {
	return Credential{AccessToken: d.access, AccountID: d.account}
}

func accessTokenExpiry(token work.Credential) (time.Time, error) {
	segments := strings.Split(token.Reveal(), ".")
	if len(segments) != 3 {
		return time.Time{}, fmt.Errorf("access token is not a JWT")
	}
	payload, err := base64.RawURLEncoding.DecodeString(segments[1])
	if err != nil {
		return time.Time{}, fmt.Errorf("access token JWT payload is not base64url")
	}
	var claims struct {
		ExpiresAt int64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil || claims.ExpiresAt <= 0 {
		return time.Time{}, fmt.Errorf("access token JWT has no usable expiry")
	}
	return time.Unix(claims.ExpiresAt, 0).UTC(), nil
}

func writeCredentialDocument(path string, document map[string]json.RawMessage) error {
	encoded, err := json.Marshal(document)
	if err != nil {
		return fmt.Errorf("encoding the rotated Codex credential file: %w", err)
	}
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, ".codex-auth-*")
	if err != nil {
		return fmt.Errorf("creating the rotated Codex credential file: %w", err)
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("protecting the rotated Codex credential file: %w", err)
	}
	if _, err := temporary.Write(encoded); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("writing the rotated Codex credential file: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("syncing the rotated Codex credential file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("closing the rotated Codex credential file: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("installing the rotated Codex credential file: %w", err)
	}
	return nil
}
