package github

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// failList answers the issue list with one prepared failure, so a taxonomy case
// is exercised over a real round trip rather than against a hand-built error.
func failList(t *testing.T, respond http.HandlerFunc) error {
	t.Helper()
	s, _ := newStub(t)
	s.handle("GET "+issuesPath, respond)
	c, _ := s.client(t)
	_, err := c.ListAutoTickets(context.Background())
	if err == nil {
		t.Fatal("ListAutoTickets succeeded where a failure was prepared")
	}
	return err
}

func TestClassifiesAPrimaryRateLimitAsPermanent(t *testing.T) {
	t.Parallel()

	err := failList(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Limit", "5000")
		w.Header().Set("X-RateLimit-Reset", "1785000000")
		writeError(w, http.StatusForbidden, "API rate limit exceeded")
	})

	// 5,000 requests an hour against single-digit calls per ticket: reaching it
	// means something is wrong, and the window is longer than any retry budget.
	assertPermanent(t, err, ErrRateLimit)
}

func TestRetriesASecondaryRateLimitAfterTheIntervalGitHubAsksFor(t *testing.T) {
	t.Parallel()

	err := failList(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-RateLimit-Remaining", "4999")
		w.Header().Set("Retry-After", "60")
		writeJSON(w, http.StatusForbidden, map[string]any{
			"message":           "You have exceeded a secondary rate limit",
			"documentation_url": "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#secondary-rate-limits",
		})
	})

	// Failing the activity would fail the whole WorkTicket workflow, discarding
	// every token already spent so far this run to save a minute.
	assertRetryable(t, err)
	if !errors.Is(err, ErrRateLimit) {
		t.Errorf("error %q is not %v", err, ErrRateLimit)
	}
	if !strings.Contains(err.Error(), "1m0s") {
		t.Errorf("error %q does not carry the interval github asked for", err)
	}
}

func TestRetriesA429AfterTheIntervalGitHubAsksFor(t *testing.T) {
	t.Parallel()

	err := failList(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "30")
		writeError(w, http.StatusTooManyRequests, "Too Many Requests")
	})

	// go-github's CheckResponse does not special-case 429; without this row it
	// falls through as a plain error and loses its Retry-After.
	assertRetryable(t, err)
	if !errors.Is(err, ErrRateLimit) {
		t.Errorf("error %q is not %v", err, ErrRateLimit)
	}
	if !strings.Contains(err.Error(), "30s") {
		t.Errorf("error %q does not carry the interval github asked for", err)
	}
}

func TestDefaultsTheRetryIntervalWhenGitHubSendsNone(t *testing.T) {
	t.Parallel()

	err := failList(t, func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusTooManyRequests, "Too Many Requests")
	})

	assertRetryable(t, err)
	if !strings.Contains(err.Error(), defaultRetryAfter.String()) {
		t.Errorf("error %q does not fall back to the default interval", err)
	}
}

func TestClassifiesAnUnauthenticatedResponseAsAPermanentAuthFailure(t *testing.T) {
	t.Parallel()

	assertPermanent(t, failList(t, func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusUnauthorized, "Bad credentials")
	}), ErrAuth)
}

func TestClassifiesAForbiddenResponseThatIsNotARateLimitAsAPermanentAuthFailure(t *testing.T) {
	t.Parallel()

	assertPermanent(t, failList(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-RateLimit-Remaining", "4999")
		writeError(w, http.StatusForbidden, "Resource not accessible by integration")
	}), ErrAuth)
}

func TestClassifiesAMalformedRequestAsPermanent(t *testing.T) {
	t.Parallel()

	assertPermanent(t, failList(t, func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusUnprocessableEntity, "Validation Failed")
	}), ErrInvalid)
}

func TestLeavesAServerErrorRetryable(t *testing.T) {
	t.Parallel()

	for _, status := range []int{http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			t.Parallel()
			assertRetryable(t, failList(t, func(w http.ResponseWriter, _ *http.Request) {
				writeError(w, status, "server error")
			}))
		})
	}
}

func TestLeavesATransportFailureRetryable(t *testing.T) {
	t.Parallel()

	assertRetryable(t, failList(t, func(w http.ResponseWriter, _ *http.Request) {
		// Hang up mid-response: no status code to classify by.
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			return
		}
		conn, _, err := hijacker.Hijack()
		if err == nil {
			_ = conn.Close()
		}
	}))
}

func TestReturnsContextCancellationUnchanged(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	listIssues(s)
	c, _ := s.client(t)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := c.ListAutoTickets(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Errorf("error %q is not a cancellation; temporal must see the run being stopped, not a failure", err)
	}
	if errors.Is(err, work.ErrPermanent) {
		t.Errorf("error %q marks cancellation as a permanent failure", err)
	}
}

func TestNamesTheOperationAndItsSubjectInEveryError(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		path string
		call func(*Client) error
		want []string
	}{
		{
			name: "listing tickets",
			path: "GET " + issuesPath,
			call: func(c *Client) error { _, err := c.ListAutoTickets(context.Background()); return err },
			want: []string{"listing", "auto"},
		},
		{
			name: "posting a status comment",
			path: "POST " + commentsPath,
			call: func(c *Client) error {
				_, err := c.PostStatus(context.Background(), testIssue, "no marker")
				return err
			},
			want: []string{"status comment", fmt.Sprintf("#%d", testIssue)},
		},
		{
			name: "rewriting a status comment",
			path: "PATCH " + commentPath,
			call: func(c *Client) error { return c.EditStatus(context.Background(), work.CommentID(999), "body") },
			want: []string{"status comment", "999"},
		},
		{
			name: "clearing the auto label",
			path: "DELETE " + autoPath,
			call: func(c *Client) error { return c.ClearAutoLabel(context.Background(), testIssue) },
			want: []string{"auto label", fmt.Sprintf("#%d", testIssue)},
		},
		{
			name: "reading a ticket",
			path: "GET " + issuePath,
			call: func(c *Client) error { _, err := c.TicketDetail(context.Background(), testIssue); return err },
			want: []string{"issue", fmt.Sprintf("#%d", testIssue)},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			s, _ := newStub(t)
			s.handle(tc.path, func(w http.ResponseWriter, _ *http.Request) {
				writeError(w, http.StatusUnauthorized, "Bad credentials")
			})
			c, _ := s.client(t)

			err := tc.call(c)
			if err == nil {
				t.Fatal("the call succeeded where a failure was prepared")
			}
			// An error read at 3am in Loki has no stack beside it.
			for _, want := range tc.want {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("error %q does not mention %q", err, want)
				}
			}
		})
	}
}

func TestMintingTheSandboxTokenNamesItsOperation(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.exchange = func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusUnauthorized, "Bad credentials")
	}
	c, _ := s.client(t)

	_, err := c.InstallationToken(context.Background())
	if err == nil {
		t.Fatal("InstallationToken succeeded where a failure was prepared")
	}
	if !strings.Contains(err.Error(), "sandbox") {
		t.Errorf("error %q does not say what the token was for", err)
	}
}
