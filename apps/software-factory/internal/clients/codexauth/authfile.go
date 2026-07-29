package codexauth

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// The keys of the codex CLI's own credential file. They are its format, not
// ours, which is why the file is patched in place rather than re-marshalled
// from a struct: anything the CLI adds that this service does not model must
// survive a rotation untouched.
const (
	keyTokens       = "tokens"
	keyAccessToken  = "access_token"
	keyRefreshToken = "refresh_token"
	keyIDToken      = "id_token"
	keyAccountID    = "account_id"
	keyLastRefresh  = "last_refresh"
)

// credentialFile is the stored credential, parsed at the boundary and losslessly.
//
// raw and tokens hold every key of the file as it was read, including ones this
// service has no model for; the Credentials beside them are the three fields it
// does. Rotation writes back through the maps, so an unmodelled field is
// preserved by construction rather than by remembering to preserve it.
type credentialFile struct {
	raw     map[string]json.RawMessage
	tokens  map[string]json.RawMessage
	access  work.Credential
	refresh work.Credential
}

// parseCredentialFile turns the stored bytes into a usable credential, or says
// why they are not one.
//
// Every rejection here is ErrUnseeded and therefore permanent, because every
// one of them describes a file only a human can fix. A blanked refresh token is
// among them: that is the shape handed to a sandbox, and a worker holding one
// has been given the wrong copy.
func parseCredentialFile(data []byte) (credentialFile, error) {
	if len(data) == 0 {
		return credentialFile{}, fmt.Errorf("the %s key is absent or empty: %w", CredentialKey, ErrUnseeded)
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return credentialFile{}, fmt.Errorf("the %s key does not hold a JSON object: %w", CredentialKey, ErrUnseeded)
	}
	tokensRaw, ok := raw[keyTokens]
	if !ok {
		return credentialFile{}, fmt.Errorf("%s carries no %q object: %w", CredentialKey, keyTokens, ErrUnseeded)
	}
	var tokens map[string]json.RawMessage
	if err := json.Unmarshal(tokensRaw, &tokens); err != nil {
		return credentialFile{}, fmt.Errorf("%s's %q is not a JSON object: %w", CredentialKey, keyTokens, ErrUnseeded)
	}

	access, err := stringField(tokens, keyAccessToken)
	if err != nil {
		return credentialFile{}, err
	}
	refresh, err := stringField(tokens, keyRefreshToken)
	if err != nil {
		return credentialFile{}, err
	}
	return credentialFile{
		raw:     raw,
		tokens:  tokens,
		access:  work.NewCredential(access),
		refresh: work.NewCredential(refresh),
	}, nil
}

// stringField reads one required token field, refusing an empty one. The value
// never reaches the error message.
func stringField(tokens map[string]json.RawMessage, key string) (string, error) {
	rawValue, ok := tokens[key]
	if !ok {
		return "", fmt.Errorf("%s's %s.%s is absent: %w", CredentialKey, keyTokens, key, ErrUnseeded)
	}
	var value string
	if err := json.Unmarshal(rawValue, &value); err != nil {
		return "", fmt.Errorf("%s's %s.%s is not a string: %w", CredentialKey, keyTokens, key, ErrUnseeded)
	}
	if value == "" {
		return "", fmt.Errorf("%s's %s.%s is blank: %w", CredentialKey, keyTokens, key, ErrUnseeded)
	}
	return value, nil
}

// withRotation returns the stored file with the rotated pair patched into it.
//
// It patches four fields and copies everything else, so the file the CLI wrote
// stays the file the CLI wrote. An omitted id_token leaves the stored one
// alone: the provider is not obliged to reissue one, and blanking a field on
// the strength of its absence from one response would be inventing a fact.
func (f credentialFile) withRotation(res Refreshed, now time.Time) ([]byte, error) {
	raw := make(map[string]json.RawMessage, len(f.raw))
	for k, v := range f.raw {
		raw[k] = v
	}
	tokens := make(map[string]json.RawMessage, len(f.tokens))
	for k, v := range f.tokens {
		tokens[k] = v
	}

	set := func(key string, value work.Credential) error {
		encoded, err := json.Marshal(value.Reveal())
		if err != nil {
			return fmt.Errorf("encoding the rotated %s.%s: %w", keyTokens, key, err)
		}
		tokens[key] = encoded
		return nil
	}
	if err := set(keyAccessToken, res.AccessToken); err != nil {
		return nil, err
	}
	if err := set(keyRefreshToken, res.RefreshToken); err != nil {
		return nil, err
	}
	if res.IDToken.Reveal() != "" {
		if err := set(keyIDToken, res.IDToken); err != nil {
			return nil, err
		}
	}

	encodedTokens, err := json.Marshal(tokens)
	if err != nil {
		return nil, fmt.Errorf("encoding the rotated %q object: %w", keyTokens, err)
	}
	raw[keyTokens] = encodedTokens
	encodedNow, err := json.Marshal(now.UTC().Format(time.RFC3339))
	if err != nil {
		return nil, fmt.Errorf("encoding the refresh timestamp: %w", err)
	}
	raw[keyLastRefresh] = encodedNow

	out, err := json.Marshal(raw)
	if err != nil {
		return nil, fmt.Errorf("encoding the rotated credential file: %w", err)
	}
	return out, nil
}

// String redacts the whole file. Its fields are Credentials already, but the
// raw maps are not, so without this a %v would print the stored token bytes.
func (f credentialFile) String() string { return "[redacted codex credential file]" }

// LogValue redacts the file in structured logs.
func (f credentialFile) LogValue() slog.Value { return slog.StringValue(f.String()) }

// expiryOf reads the exp claim from an access token without verifying its
// signature.
//
// We are not authenticating the token — the provider does that on use — only
// reading the lifetime it declares, so verification would buy nothing and need
// a key we do not have.
//
// Every failure is an error rather than "assume expired". Assuming expired
// would refresh, fail to read the new token in exactly the same way, and burn
// the whole rotating chain in a loop.
func expiryOf(accessToken work.Credential) (time.Time, error) {
	segments := strings.Split(accessToken.Reveal(), ".")
	if len(segments) != 3 {
		return time.Time{}, fmt.Errorf("the access token is not three dot-separated segments, so its expiry cannot be read")
	}
	payload, err := base64.RawURLEncoding.DecodeString(segments[1])
	if err != nil {
		return time.Time{}, fmt.Errorf("the access token's payload is not base64url, so its expiry cannot be read")
	}
	var claims struct {
		Exp *int64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return time.Time{}, fmt.Errorf("the access token's payload is not JSON with a numeric exp claim, so its expiry cannot be read")
	}
	if claims.Exp == nil || *claims.Exp <= 0 {
		return time.Time{}, fmt.Errorf("the access token carries no usable exp claim, so its expiry cannot be read")
	}
	return time.Unix(*claims.Exp, 0).UTC(), nil
}
