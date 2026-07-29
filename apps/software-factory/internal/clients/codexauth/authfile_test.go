package codexauth

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// unsignedJWT builds a token with the given expiry and a signature that is not
// one. Nothing in this package verifies a signature — the provider does that on
// use — so a synthetic token exercises every path a real one would, and no
// credential-shaped string ever enters the repository.
func unsignedJWT(t *testing.T, exp time.Time) string {
	t.Helper()
	payload, err := json.Marshal(map[string]int64{"exp": exp.Unix()})
	if err != nil {
		t.Fatalf("building a test token: %v", err)
	}
	enc := base64.RawURLEncoding.EncodeToString
	return enc([]byte(`{"alg":"none"}`)) + "." + enc(payload) + "." + enc([]byte("not-a-signature"))
}

// seedFile builds a stored credential file carrying the given tokens.
func seedFile(t *testing.T, access, refresh string) []byte {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		keyTokens: map[string]any{
			keyAccessToken:  access,
			keyRefreshToken: refresh,
			keyIDToken:      "stored-id-token",
			keyAccountID:    "acct_stored",
		},
		keyLastRefresh: "2026-07-01T00:00:00Z",
	})
	if err != nil {
		t.Fatalf("building a test credential file: %v", err)
	}
	return raw
}

func TestExpiryOfReadsTheExpiryFromAnAccessTokensExpClaim(t *testing.T) {
	t.Parallel()
	want := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)

	got, err := expiryOf(work.NewCredential(unsignedJWT(t, want)))
	if err != nil {
		t.Fatalf("expiryOf: %v", err)
	}
	if !got.Equal(want) {
		t.Errorf("expiry = %s, want %s", got, want)
	}
}

func TestExpiryOfRefusesATokenItCannotRead(t *testing.T) {
	t.Parallel()
	enc := base64.RawURLEncoding.EncodeToString

	// Every one of these must be an error rather than a zero time. "Assume
	// expired" would refresh, fail to read the new token in exactly the same
	// way, and burn the whole credential chain in a loop.
	cases := map[string]string{
		"not three dot-separated segments": "header.payload",
		"a payload that is not base64url":  "aaa.!!!not-base64!!!.ccc",
		"a payload that is not JSON":       "aaa." + enc([]byte("{{{")) + ".ccc",
		"a payload carrying no exp claim":  "aaa." + enc([]byte(`{"sub":"x"}`)) + ".ccc",
		"a non-numeric exp claim":          "aaa." + enc([]byte(`{"exp":"soon"}`)) + ".ccc",
		"an exp claim at or before zero":   "aaa." + enc([]byte(`{"exp":0}`)) + ".ccc",
	}
	for name, token := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := expiryOf(work.NewCredential(token)); err == nil {
				t.Fatal("expiryOf accepted a token it cannot read, want an error")
			}
		})
	}
}

func TestCredentialFilePreservesEveryFieldItDoesNotOwnAcrossARotation(t *testing.T) {
	t.Parallel()
	stored := []byte(`{
		"OPENAI_API_KEY": null,
		"some_future_key": {"nested": ["a", 1, true]},
		"tokens": {
			"access_token": "old-access",
			"refresh_token": "old-refresh",
			"id_token": "old-id",
			"account_id": "acct_123",
			"some_future_token_field": 42
		},
		"last_refresh": "2026-07-01T00:00:00Z"
	}`)

	file, err := parseCredentialFile(stored)
	if err != nil {
		t.Fatalf("parseCredentialFile: %v", err)
	}
	rotated, err := file.withRotation(Refreshed{
		AccessToken:  work.NewCredential("new-access"),
		RefreshToken: work.NewCredential("new-refresh"),
		IDToken:      work.NewCredential("new-id"),
	}, time.Date(2026, 7, 28, 9, 30, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("withRotation: %v", err)
	}

	var got map[string]any
	if err := json.Unmarshal(rotated, &got); err != nil {
		t.Fatalf("the rotated file is not JSON: %v", err)
	}
	tokens, ok := got[keyTokens].(map[string]any)
	if !ok {
		t.Fatalf("tokens = %#v, want an object", got[keyTokens])
	}

	// An unmodelled field is not ours to drop. The next codex release can add
	// one, and a rotation that silently deleted it would corrupt the file for
	// whoever does own it.
	if _, ok := got["OPENAI_API_KEY"]; !ok {
		t.Error("OPENAI_API_KEY was dropped by a rotation")
	}
	if fmt.Sprint(got["some_future_key"]) != `map[nested:[a 1 true]]` {
		t.Errorf("some_future_key = %#v, want it preserved", got["some_future_key"])
	}
	if tokens[keyAccountID] != "acct_123" {
		t.Errorf("tokens.account_id = %#v, want it preserved", tokens[keyAccountID])
	}
	if tokens["some_future_token_field"] != float64(42) {
		t.Errorf("tokens.some_future_token_field = %#v, want it preserved", tokens["some_future_token_field"])
	}
}

func TestCredentialFileRewritesOnlyTheTokensAndTheRefreshTimestamp(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 7, 28, 9, 30, 0, 0, time.UTC)
	file, err := parseCredentialFile(seedFile(t, "old-access", "old-refresh"))
	if err != nil {
		t.Fatalf("parseCredentialFile: %v", err)
	}
	rotated, err := file.withRotation(Refreshed{
		AccessToken:  work.NewCredential("new-access"),
		RefreshToken: work.NewCredential("new-refresh"),
		IDToken:      work.NewCredential("new-id"),
	}, now)
	if err != nil {
		t.Fatalf("withRotation: %v", err)
	}

	var got struct {
		Tokens struct {
			Access    string `json:"access_token"`
			Refresh   string `json:"refresh_token"`
			ID        string `json:"id_token"`
			AccountID string `json:"account_id"`
		} `json:"tokens"`
		LastRefresh string `json:"last_refresh"`
	}
	if err := json.Unmarshal(rotated, &got); err != nil {
		t.Fatalf("the rotated file is not JSON: %v", err)
	}
	if got.Tokens.Access != "new-access" || got.Tokens.Refresh != "new-refresh" || got.Tokens.ID != "new-id" {
		t.Errorf("rotated tokens = %+v, want all three replaced", got.Tokens)
	}
	if got.Tokens.AccountID != "acct_stored" {
		t.Errorf("account_id = %q, want it untouched", got.Tokens.AccountID)
	}
	// RFC3339 UTC on the wire, from the injected clock and nowhere else.
	if got.LastRefresh != "2026-07-28T09:30:00Z" {
		t.Errorf("last_refresh = %q, want the injected clock's time in RFC3339 UTC", got.LastRefresh)
	}
}

func TestCredentialFileKeepsTheStoredIDTokenWhenARotationOmitsOne(t *testing.T) {
	t.Parallel()
	file, err := parseCredentialFile(seedFile(t, "old-access", "old-refresh"))
	if err != nil {
		t.Fatalf("parseCredentialFile: %v", err)
	}
	rotated, err := file.withRotation(Refreshed{
		AccessToken:  work.NewCredential("new-access"),
		RefreshToken: work.NewCredential("new-refresh"),
	}, time.Date(2026, 7, 28, 9, 30, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("withRotation: %v", err)
	}

	var got struct {
		Tokens struct {
			ID string `json:"id_token"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(rotated, &got); err != nil {
		t.Fatalf("the rotated file is not JSON: %v", err)
	}
	if got.Tokens.ID != "stored-id-token" {
		t.Errorf("id_token = %q, want the stored one kept when the response omits it", got.Tokens.ID)
	}
}

func TestCredentialFileRejectsAFileItCannotUse(t *testing.T) {
	t.Parallel()
	cases := map[string][]byte{
		"a file that is not JSON":        []byte("{{{"),
		"a file with no tokens object":   []byte(`{"OPENAI_API_KEY": "x"}`),
		"a file with no access token":    []byte(`{"tokens":{"refresh_token":"r"}}`),
		"a file with an empty access":    []byte(`{"tokens":{"access_token":"","refresh_token":"r"}}`),
		"a tokens object that is a list": []byte(`{"tokens":[]}`),
		// A blanked refresh token is the shape handed to a sandbox. If the
		// worker ever reads one it has been given a sandbox's copy, and
		// refreshing from it would present an empty string to the provider.
		"a file with a blanked refresh": []byte(`{"tokens":{"access_token":"a","refresh_token":""}}`),
	}
	for name, stored := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := parseCredentialFile(stored)
			if !errors.Is(err, ErrUnseeded) {
				t.Fatalf("parseCredentialFile returned %v, want it to wrap ErrUnseeded", err)
			}
			if !errors.Is(err, work.ErrPermanent) {
				t.Error("an unseeded credential must be permanent — a retry cannot seed it")
			}
		})
	}
}

func TestCredentialFileNeverPrintsATokenWhenFormattedOrLogged(t *testing.T) {
	t.Parallel()
	const access, refresh = "SECRET-ACCESS-VALUE", "SECRET-REFRESH-VALUE"

	file, err := parseCredentialFile(seedFile(t, access, refresh))
	if err != nil {
		t.Fatalf("parseCredentialFile: %v", err)
	}
	res := Refreshed{
		AccessToken:  work.NewCredential(access),
		RefreshToken: work.NewCredential(refresh),
		IDToken:      work.NewCredential("SECRET-ID-VALUE"),
	}

	var logged strings.Builder
	log := slog.New(slog.NewJSONHandler(&logged, nil))
	log.Info("a stray log line", "file", file, "refreshed", res, "wrapped", fmt.Errorf("context: %w", errRefreshedForTest(res)))

	rendered := []string{logged.String()}
	for _, verb := range []string{"%v", "%+v", "%s", "%q"} {
		rendered = append(rendered, fmt.Sprintf(verb, file), fmt.Sprintf(verb, res))
	}
	for _, out := range rendered {
		for _, secret := range []string{access, refresh, "SECRET-ID-VALUE"} {
			if strings.Contains(out, secret) {
				t.Fatalf("a token reached a rendered string; one %%v away from Loki")
			}
		}
	}
}

// errRefreshedForTest wraps a Refreshed into an error the way a careless caller
// might, so the leak test covers the error path too.
func errRefreshedForTest(r Refreshed) error { return fmt.Errorf("refreshing gave %v", r) }
