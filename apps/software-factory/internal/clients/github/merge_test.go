package github

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

const mergePath = "/repos/" + testOwner + "/" + testRepo + "/pulls/9/merge"

func TestMergePullRequestSquashesTheExpectedHeadAndConfirmsTheReturnedSHA(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("PUT "+mergePath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"merged": true, "sha": "merge-sha"})
	})
	c, _ := s.client(t)

	result, err := c.MergePullRequest(t.Context(), 9, "reviewed-head")
	if err != nil {
		t.Fatalf("MergePullRequest: %v", err)
	}
	if result.Outcome != work.PullRequestMergeConfirmed || result.MergeSHA != "merge-sha" {
		t.Fatalf("result = %+v, want a confirmed merge-sha", result)
	}

	sent := decodeBody(t, s.first(t, "PUT "+mergePath))
	if sent["merge_method"] != "squash" || sent["sha"] != "reviewed-head" || len(sent) != 2 {
		t.Fatalf("merge body = %v, want only squash and the reviewed head", sent)
	}
	if got := s.count("POST /graphql"); got != 0 {
		t.Fatalf("made %d GraphQL calls after a confirmed REST merge, want no target-path review or auto-merge mutation", got)
	}
}

func TestMergePullRequestConfirmsAMergeOnlyFromGraphQLMergedAndMergeCommit(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("PUT "+mergePath, func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusConflict, "merge response lost")
	})
	s.handle("POST /graphql", func(w http.ResponseWriter, r *http.Request) {
		var request graphQLRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decoding reconciliation query: %v", err)
		}
		if !strings.Contains(request.Query, "mergeCommit") {
			t.Fatal("reconciliation query does not request mergeCommit")
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequest": map[string]any{
			"number": 9, "id": "PR_kwDOtest9", "state": "CLOSED", "headRefOid": "reviewed-head", "baseRefOid": "base-sha", "mergeable": "MERGEABLE", "merged": true,
			"mergeCommit": map[string]any{"oid": "merge-sha"},
		}}}})
	})
	c, _ := s.client(t)

	result, err := c.MergePullRequest(t.Context(), 9, "reviewed-head")
	if err != nil {
		t.Fatalf("MergePullRequest: %v", err)
	}
	if result.Outcome != work.PullRequestMergeConfirmed || result.MergeSHA != "merge-sha" {
		t.Fatalf("result = %+v, want authoritative confirmed merge", result)
	}
}

func TestMergePullRequestDoesNotTreatClosedOrMergeSHAAloneAsAConfirmedMerge(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("PUT "+mergePath, func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusUnprocessableEntity, "merge could not be completed")
	})
	s.handle("POST /graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequest": map[string]any{
			"number": 9, "id": "PR_kwDOtest9", "state": "CLOSED", "headRefOid": "reviewed-head", "baseRefOid": "base-sha", "mergeable": "MERGEABLE", "merged": false,
			"mergeCommit": map[string]any{"oid": "unconfirmed-sha"},
		}}}})
	})
	c, _ := s.client(t)

	result, err := c.MergePullRequest(t.Context(), 9, "reviewed-head")
	if err != nil {
		t.Fatalf("MergePullRequest: %v", err)
	}
	if result.Outcome != work.PullRequestMergeClosedUnmerged {
		t.Fatalf("result = %+v, want closed-unmerged", result)
	}
}

func TestMergePullRequestReconcilesALostResponseBeforeRetrying(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("PUT "+mergePath, func(w http.ResponseWriter, _ *http.Request) {
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			t.Fatal("test server response cannot simulate a dropped connection")
		}
		conn, _, err := hijacker.Hijack()
		if err != nil {
			t.Fatalf("hijacking merge response: %v", err)
		}
		_ = conn.Close()
	})
	s.handle("POST /graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequest": reconciledPullRequest("OPEN", "reviewed-head", "UNKNOWN", false, "")}}})
	})
	c, _ := s.client(t)

	result, err := c.MergePullRequest(t.Context(), 9, "reviewed-head")
	if err != nil {
		t.Fatalf("MergePullRequest: %v", err)
	}
	if result.Outcome != work.PullRequestMergeRetryableAmbiguity {
		t.Fatalf("result = %+v, want retryable ambiguity after a dropped response", result)
	}
}

func TestMergePullRequestPreservesARateLimitsTemporalRetryClassification(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("PUT "+mergePath, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "30")
		writeError(w, http.StatusTooManyRequests, "Too Many Requests")
	})
	c, _ := s.client(t)

	_, err := c.MergePullRequest(t.Context(), 9, "reviewed-head")
	if err == nil {
		t.Fatal("MergePullRequest succeeded despite a rate limit")
	}
	if !errors.Is(err, ErrRateLimit) || errors.Is(err, work.ErrPermanent) {
		t.Fatalf("error = %v, want a retryable rate-limit classification", err)
	}
	if got := s.count("POST /graphql"); got != 0 {
		t.Fatalf("made %d reconciliation calls for a known rate limit, want 0", got)
	}
}

func TestMergePullRequestClassifiesAnUnmergedReconciliation(t *testing.T) {
	t.Parallel()

	cases := map[string]struct {
		status  int
		message string
		pr      map[string]any
		want    work.PullRequestMergeOutcome
	}{
		"text conflict": {
			status: http.StatusMethodNotAllowed,
			pr:     reconciledPullRequest("OPEN", "reviewed-head", "CONFLICTING", false, ""),
			want:   work.PullRequestMergeTextConflict,
		},
		"head changed": {
			status: http.StatusConflict,
			pr:     reconciledPullRequest("OPEN", "new-head", "MERGEABLE", false, ""),
			want:   work.PullRequestMergeHeadChanged,
		},
		"base refresh required": {
			status:  http.StatusUnprocessableEntity,
			message: "Base branch was modified. Review and try the merge again.",
			pr:      reconciledPullRequest("OPEN", "reviewed-head", "MERGEABLE", false, ""),
			want:    work.PullRequestMergeBaseRefreshRequired,
		},
		"mergeability computing": {
			status: http.StatusUnprocessableEntity,
			pr:     reconciledPullRequest("OPEN", "reviewed-head", "UNKNOWN", false, ""),
			want:   work.PullRequestMergeRetryableAmbiguity,
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			s, _ := newStub(t)
			s.handle("PUT "+mergePath, func(w http.ResponseWriter, _ *http.Request) {
				writeError(w, tc.status, tc.message)
			})
			s.handle("POST /graphql", func(w http.ResponseWriter, _ *http.Request) {
				writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequest": tc.pr}}})
			})
			c, _ := s.client(t)

			result, err := c.MergePullRequest(t.Context(), 9, "reviewed-head")
			if err != nil {
				t.Fatalf("MergePullRequest: %v", err)
			}
			if result.Outcome != tc.want {
				t.Fatalf("result = %+v, want %s", result, tc.want)
			}
		})
	}
}

func reconciledPullRequest(state, head, mergeable string, merged bool, mergeSHA string) map[string]any {
	pr := map[string]any{
		"number": 9, "id": "PR_kwDOtest9", "state": state, "headRefOid": head, "baseRefOid": "base-sha", "mergeable": mergeable, "merged": merged,
	}
	if mergeSHA == "" {
		pr["mergeCommit"] = nil
	} else {
		pr["mergeCommit"] = map[string]any{"oid": mergeSHA}
	}
	return pr
}
