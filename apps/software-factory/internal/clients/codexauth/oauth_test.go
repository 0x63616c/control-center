package codexauth

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

const (
	testClientID = "test-client-id"
	testToken    = "SECRET-REFRESH-VALUE"
)

func newTestRefresher(t *testing.T, handler http.HandlerFunc) *HTTPRefresher {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	refresher, err := NewHTTPRefresher(&http.Client{Timeout: 5 * time.Second}, server.URL, testClientID)
	if err != nil {
		t.Fatalf("NewHTTPRefresher: %v", err)
	}
	return refresher
}

func TestHTTPRefresherPostsTheRefreshGrantAsFormEncodedParameters(t *testing.T) {
	t.Parallel()
	var (
		gotURL         string
		gotContentType string
		gotForm        string
	)
	refresher := newTestRefresher(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		gotURL, gotContentType, gotForm = r.URL.String(), r.Header.Get("Content-Type"), string(body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"a","refresh_token":"r","id_token":"i"}`))
	})

	if _, _, err := refresher.Refresh(context.Background(), work.NewCredential(testToken)); err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if gotContentType != "application/x-www-form-urlencoded" {
		t.Errorf("Content-Type = %q, want form encoding", gotContentType)
	}
	for _, want := range []string{"grant_type=refresh_token", "client_id=" + testClientID, "refresh_token=" + testToken} {
		if !strings.Contains(gotForm, want) {
			t.Errorf("the request body does not carry %q", want)
		}
	}
	// A token in a query string is a token in every proxy and access log
	// between here and the provider.
	if strings.Contains(gotURL, testToken) {
		t.Error("the refresh token reached the URL; it belongs in the body and nowhere else")
	}
}

func TestHTTPRefresherParsesTheRotatedPairAsARotationOutcome(t *testing.T) {
	t.Parallel()
	refresher := newTestRefresher(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"new-a","refresh_token":"new-r","id_token":"new-i"}`))
	})

	res, outcome, err := refresher.Refresh(context.Background(), work.NewCredential(testToken))
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if outcome != RefreshRotated {
		t.Fatalf("outcome = %s, want %s", outcome, RefreshRotated)
	}
	if res.AccessToken.Reveal() != "new-a" || res.RefreshToken.Reveal() != "new-r" || res.IDToken.Reveal() != "new-i" {
		t.Error("Refresh did not return all three rotated tokens")
	}
}

func TestHTTPRefresherRefusesAResponseThatRotatesOnlyHalfThePair(t *testing.T) {
	t.Parallel()
	// A response with an access token and no refresh token would store a
	// blank refresh token over a live one, which is a dead credential the next
	// time anything needs to rotate.
	refresher := newTestRefresher(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"access_token":"new-a"}`))
	})

	_, outcome, err := refresher.Refresh(context.Background(), work.NewCredential(testToken))
	if err == nil {
		t.Fatal("Refresh accepted a response carrying no refresh token")
	}
	if outcome != RefreshUnknown {
		t.Errorf("outcome = %s, want %s — the grant was consumed and we cannot use what came back", outcome, RefreshUnknown)
	}
}

func TestHTTPRefresherReportsAnInvalidGrantAsARejection(t *testing.T) {
	t.Parallel()
	for _, status := range []int{http.StatusBadRequest, http.StatusUnauthorized} {
		refresher := newTestRefresher(t, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"error":"invalid_grant","error_description":"token expired or revoked"}`))
		})
		_, outcome, err := refresher.Refresh(context.Background(), work.NewCredential(testToken))
		if outcome != RefreshRejected {
			t.Errorf("status %d gave outcome %s, want %s", status, outcome, RefreshRejected)
		}
		if err == nil || !strings.Contains(err.Error(), "invalid_grant") {
			t.Errorf("status %d gave %v, want an error naming the provider's reason", status, err)
		}
	}
}

func TestHTTPRefresherReportsAServerFailureAsAnUnknownOutcome(t *testing.T) {
	t.Parallel()
	// The deliberate availability sacrifice. A token endpoint that answered
	// non-200 may or may not have consumed the grant, and for a single-use
	// credential an unknown is an unknown.
	for _, status := range []int{http.StatusTooManyRequests, http.StatusServiceUnavailable, http.StatusInternalServerError} {
		refresher := newTestRefresher(t, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"error":"server_error"}`))
		})
		_, outcome, err := refresher.Refresh(context.Background(), work.NewCredential(testToken))
		if outcome != RefreshUnknown {
			t.Errorf("status %d gave outcome %s, want %s — treating it as retryable presents the token twice", status, outcome, RefreshUnknown)
		}
		if err == nil {
			t.Errorf("status %d gave no error", status)
		}
	}
}

func TestHTTPRefresherReportsAnUnreachableEndpointAsNeverSent(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := server.URL
	server.Close()

	refresher, err := NewHTTPRefresher(&http.Client{Timeout: 5 * time.Second}, url, testClientID)
	if err != nil {
		t.Fatalf("NewHTTPRefresher: %v", err)
	}
	_, outcome, err := refresher.Refresh(context.Background(), work.NewCredential(testToken))
	if err == nil {
		t.Fatal("Refresh succeeded against a closed listener")
	}
	// Nothing was written, so the token is untouched and this is an ordinary
	// blip. This is the classification that keeps INV-2 affordable.
	if outcome != RefreshNotSent {
		t.Errorf("outcome = %s, want %s", outcome, RefreshNotSent)
	}
}

func TestHTTPRefresherReportsAHungResponseAsAnUnknownOutcome(t *testing.T) {
	t.Parallel()
	hang := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-hang }))
	t.Cleanup(func() { close(hang); server.Close() })

	refresher, err := NewHTTPRefresher(&http.Client{Timeout: 50 * time.Millisecond}, server.URL, testClientID)
	if err != nil {
		t.Fatalf("NewHTTPRefresher: %v", err)
	}
	_, outcome, err := refresher.Refresh(context.Background(), work.NewCredential(testToken))
	if err == nil {
		t.Fatal("Refresh succeeded against a handler that never answered")
	}
	// The request was written. The provider may well have rotated the pair and
	// we simply did not hear it, so this must never be retried.
	if outcome != RefreshUnknown {
		t.Errorf("outcome = %s, want %s — the request reached the wire", outcome, RefreshUnknown)
	}
}

func TestNewHTTPRefresherRefusesAnUnusableConfiguration(t *testing.T) {
	t.Parallel()
	cases := map[string]func() (*HTTPRefresher, error){
		// An unbounded presentation would invalidate the lease-expiry
		// reasoning the takeover policy rests on.
		"a client with no timeout": func() (*HTTPRefresher, error) {
			return NewHTTPRefresher(&http.Client{}, "https://example.invalid/token", testClientID)
		},
		"no client": func() (*HTTPRefresher, error) {
			return NewHTTPRefresher(nil, "https://example.invalid/token", testClientID)
		},
		"no token URL": func() (*HTTPRefresher, error) {
			return NewHTTPRefresher(&http.Client{Timeout: time.Second}, "", testClientID)
		},
		"no client ID": func() (*HTTPRefresher, error) {
			return NewHTTPRefresher(&http.Client{Timeout: time.Second}, "https://example.invalid/token", "")
		},
		// The token travels in the request body, so plaintext to anywhere
		// but loopback puts it on the wire in the clear.
		"a plaintext URL to a remote host": func() (*HTTPRefresher, error) {
			return NewHTTPRefresher(&http.Client{Timeout: time.Second}, "http://example.invalid/token", testClientID)
		},
		"a URL that is not a URL": func() (*HTTPRefresher, error) {
			return NewHTTPRefresher(&http.Client{Timeout: time.Second}, "://nope", testClientID)
		},
	}
	for name, construct := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			refresher, err := construct()
			if err == nil {
				t.Fatal("NewHTTPRefresher returned a usable-but-invalid refresher, want an error")
			}
			if refresher != nil {
				t.Error("NewHTTPRefresher returned both a refresher and an error")
			}
		})
	}
}

func TestHTTPRefresherNeverPutsATokenInAnError(t *testing.T) {
	t.Parallel()
	// Errors from here are wrapped and logged all the way up. One that
	// interpolated the token would write it to Loki on every failure.
	refresher := newTestRefresher(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"invalid_grant"}`))
	})
	res, _, err := refresher.Refresh(context.Background(), work.NewCredential(testToken))
	if err == nil {
		t.Fatal("Refresh succeeded")
	}
	if strings.Contains(err.Error(), testToken) {
		t.Error("the refresh token reached an error string")
	}
	if strings.Contains(res.String(), testToken) {
		t.Error("the refresh token reached a rendered Refreshed")
	}
}
