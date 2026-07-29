package codexauth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strings"
	"sync/atomic"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// maxResponseBytes bounds what is read back. The response is four short
// strings; anything larger is a misconfigured endpoint, not a credential.
const maxResponseBytes = 1 << 20

// HTTPRefresher is the real TokenRefresher, talking to the provider's token
// endpoint.
//
// The endpoint and the client ID are constructor arguments rather than
// constants because they are the provider's facts, not this package's, and the
// composition root is where facts about the outside world are chosen.
type HTTPRefresher struct {
	client   *http.Client
	tokenURL string
	clientID string
}

// NewHTTPRefresher constructs one.
//
// It rejects a client with no Timeout. An unbounded presentation would
// invalidate the lease-expiry reasoning this package's takeover policy depends
// on, and a single mechanism failing silently would leave that reasoning
// looking sound while being false.
func NewHTTPRefresher(client *http.Client, tokenURL, clientID string) (*HTTPRefresher, error) {
	switch {
	case client == nil:
		return nil, fmt.Errorf("a codex token refresher needs an HTTP client")
	case client.Timeout <= 0:
		return nil, fmt.Errorf("a codex token refresher needs a client with a timeout: an unbounded presentation makes an expired lease uninterpretable")
	case tokenURL == "":
		return nil, fmt.Errorf("a codex token refresher needs the provider's token endpoint")
	case clientID == "":
		return nil, fmt.Errorf("a codex token refresher needs the OAuth client id")
	}
	parsed, err := url.Parse(tokenURL)
	if err != nil {
		return nil, fmt.Errorf("the codex token endpoint %q is not a URL: %w", tokenURL, err)
	}
	// The refresh token travels in the request body, so plaintext to anywhere
	// but loopback puts a credential on the wire in the clear.
	if parsed.Scheme != "https" && (parsed.Scheme != "http" || !isLoopback(parsed.Host)) {
		return nil, fmt.Errorf("the codex token endpoint %q must be https, or http to loopback for tests", tokenURL)
	}
	return &HTTPRefresher{client: client, tokenURL: tokenURL, clientID: clientID}, nil
}

func isLoopback(host string) bool {
	name, _, err := net.SplitHostPort(host)
	if err != nil {
		name = host
	}
	if name == "localhost" {
		return true
	}
	ip := net.ParseIP(name)
	return ip != nil && ip.IsLoopback()
}

// Refresh exchanges a refresh token for a new pair, and says what became of the
// token it was given.
func (r *HTTPRefresher) Refresh(ctx context.Context, refreshToken work.Credential) (Refreshed, RefreshOutcome, error) {
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {r.clientID},
		"refresh_token": {refreshToken.Reveal()},
	}

	// "Did the request reach the wire" is decided by the transport telling us,
	// not by matching error strings. Conservative in one direction on purpose:
	// WroteRequest counts even when it reports an error, because a partially
	// written request wrongly called "not sent" licenses a second presentation,
	// while a failed request wrongly called "sent" only costs a needless halt.
	// The error directions are asymmetric and so is the rule.
	var reached atomic.Bool
	trace := &httptrace.ClientTrace{
		WroteRequest:         func(httptrace.WroteRequestInfo) { reached.Store(true) },
		GotFirstResponseByte: func() { reached.Store(true) },
	}
	req, err := http.NewRequestWithContext(httptrace.WithClientTrace(ctx, trace), http.MethodPost, r.tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return Refreshed{}, RefreshNotSent, fmt.Errorf("building the codex refresh request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := r.client.Do(req)
	if err != nil {
		if reached.Load() {
			return Refreshed{}, RefreshUnknown, fmt.Errorf("the codex refresh request was sent and no usable answer came back: %w", err)
		}
		return Refreshed{}, RefreshNotSent, fmt.Errorf("the codex refresh request never reached %s: %w", r.tokenURL, err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return Refreshed{}, RefreshUnknown, fmt.Errorf("reading the codex token endpoint's answer: %w", err)
	}
	return classify(resp.StatusCode, body)
}

// tokenResponse is the token endpoint's answer. Only the fields this service
// stores are modelled; the credential file preserves everything else it already
// holds.
type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
	Error        string `json:"error"`
	Description  string `json:"error_description"`
}

// classify turns one HTTP answer into an outcome.
//
// Everything that is not an unambiguous success or an unambiguous refusal is
// unknown — including 429 and every 5xx. That is a deliberate availability
// sacrifice: an endpoint that answered non-200 may or may not have consumed the
// grant, and for a single-use credential, guessing "not consumed" is the guess
// that destroys it.
func classify(status int, body []byte) (Refreshed, RefreshOutcome, error) {
	var parsed tokenResponse
	// A body that does not parse is not fatal to the classification; the
	// status still carries most of the answer.
	parseErr := json.Unmarshal(body, &parsed)

	switch {
	case status == http.StatusOK:
		if parseErr != nil {
			return Refreshed{}, RefreshUnknown, fmt.Errorf("the codex token endpoint answered 200 with a body that is not JSON: %w", parseErr)
		}
		if parsed.AccessToken == "" || parsed.RefreshToken == "" {
			// Storing half a pair would blank a live refresh token, which is
			// a dead credential the next time anything needs to rotate.
			return Refreshed{}, RefreshUnknown, fmt.Errorf("the codex token endpoint answered 200 without both an access and a refresh token")
		}
		return Refreshed{
			AccessToken:  work.NewCredential(parsed.AccessToken),
			RefreshToken: work.NewCredential(parsed.RefreshToken),
			IDToken:      work.NewCredential(parsed.IDToken),
		}, RefreshRotated, nil

	case (status == http.StatusBadRequest || status == http.StatusUnauthorized) && parsed.Error == "invalid_grant":
		return Refreshed{}, RefreshRejected, fmt.Errorf("the codex token endpoint refused the refresh token (%d %s: %s)", status, parsed.Error, parsed.Description)

	default:
		return Refreshed{}, RefreshUnknown, fmt.Errorf("the codex token endpoint answered %d (%s), so whether it consumed the refresh token is unknown", status, parsed.Error)
	}
}
