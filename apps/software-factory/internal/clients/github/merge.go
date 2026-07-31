package github

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	gh "github.com/google/go-github/v78/github"
)

const pullRequestMergeStateQuery = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number
      id
      state
      headRefOid
      baseRefOid
      mergeable
      merged
      mergeCommit { oid }
    }
  }
}`

type pullRequestMergeStateResponse struct {
	Data struct {
		Repository struct {
			PullRequest *graphQLPullRequest `json:"pullRequest"`
		} `json:"repository"`
	} `json:"data"`
	Errors []graphQLError `json:"errors"`
}

type graphQLPullRequest struct {
	Number      int    `json:"number"`
	NodeID      string `json:"id"`
	State       string `json:"state"`
	HeadSHA     string `json:"headRefOid"`
	BaseSHA     string `json:"baseRefOid"`
	Mergeable   string `json:"mergeable"`
	Merged      bool   `json:"merged"`
	MergeCommit *struct {
		SHA string `json:"oid"`
	} `json:"mergeCommit"`
}

// MergePullRequest asks GitHub to squash-merge one reviewed pull-request head.
//
// A response is only confirmed when GitHub explicitly says merged and supplies
// the merge commit SHA. Every ambiguous outcome is reconciled from GraphQL so
// a lost REST response cannot cause a second semantic merge request.
func (c *Client) MergePullRequest(ctx context.Context, number int, expectedHeadSHA string) (work.PullRequestMergeResult, error) {
	op := fmt.Sprintf("squash-merging pull request #%d at %s", number, expectedHeadSHA)
	if number <= 0 || expectedHeadSHA == "" {
		return work.PullRequestMergeResult{}, permanent(op, ErrInvalid, errors.New("pull request number and expected head sha are required"))
	}

	merged, _, err := c.api.PullRequests.Merge(ctx, c.owner, c.repo, number, "", &gh.PullRequestOptions{
		MergeMethod: "squash",
		SHA:         expectedHeadSHA,
	})
	if err == nil && merged.GetMerged() && merged.GetSHA() != "" {
		return work.PullRequestMergeResult{
			Outcome:  work.PullRequestMergeConfirmed,
			MergeSHA: merged.GetSHA(),
		}, nil
	}
	if err != nil && !mergeResponseNeedsReconciliation(ctx, err) {
		return work.PullRequestMergeResult{}, classify(ctx, op, err)
	}

	// A merge response is an at-least-once boundary. GitHub can accept it while
	// the connection is lost, and its 405/409/422 answers overlap normal state
	// changes. Reconciliation is therefore mandatory before classification.
	state, reconcileErr := c.pullRequestMergeState(ctx, number)
	if reconcileErr != nil {
		if err == nil {
			return work.PullRequestMergeResult{}, reconcileErr
		}
		return work.PullRequestMergeResult{}, fmt.Errorf("%s: reconciling the ambiguous merge response: %w", op, reconcileErr)
	}

	return classifyMergeState(state, expectedHeadSHA, mergeMessage(err, merged)), nil
}

// mergeResponseNeedsReconciliation identifies responses whose HTTP outcome
// cannot say whether GitHub performed the merge. Known transient and
// rate-limit responses retain classify's Temporal retry taxonomy instead.
func mergeResponseNeedsReconciliation(ctx context.Context, err error) bool {
	if ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || alreadyClassified(err) {
		return false
	}

	var response *gh.ErrorResponse
	if errors.As(err, &response) {
		switch response.Response.StatusCode {
		case http.StatusMethodNotAllowed, http.StatusConflict, http.StatusUnprocessableEntity:
			return true
		default:
			return false
		}
	}

	// No HTTP response is a lost-response boundary: the request may have
	// reached GitHub after the connection stopped carrying its answer.
	return true
}

func (c *Client) pullRequestMergeState(ctx context.Context, number int) (graphQLPullRequest, error) {
	op := fmt.Sprintf("reading authoritative merge state for pull request #%d", number)
	body, err := json.Marshal(graphQLRequest{
		Query: pullRequestMergeStateQuery,
		Variables: map[string]any{
			"owner":  c.owner,
			"repo":   c.repo,
			"number": number,
		},
	})
	if err != nil {
		return graphQLPullRequest{}, fmt.Errorf("%s: encoding the graphql request: %w", op, err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.graphqlURL, bytes.NewReader(body))
	if err != nil {
		return graphQLPullRequest{}, fmt.Errorf("%s: building the graphql request: %w", op, err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.api.Client().Do(req)
	if err != nil {
		return graphQLPullRequest{}, fmt.Errorf("%s: %w", op, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if checked := gh.CheckResponse(resp); checked != nil {
		return graphQLPullRequest{}, classify(ctx, op, checked)
	}

	var decoded pullRequestMergeStateResponse
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		return graphQLPullRequest{}, fmt.Errorf("%s: decoding the graphql response: %w", op, err)
	}
	if len(decoded.Errors) > 0 {
		return graphQLPullRequest{}, classifyGraphQLErrors(op, decoded.Errors)
	}
	if decoded.Data.Repository.PullRequest == nil {
		return graphQLPullRequest{}, permanent(op, ErrNotFound, errors.New("github returned no pull request"))
	}
	return *decoded.Data.Repository.PullRequest, nil
}

func classifyMergeState(state graphQLPullRequest, expectedHeadSHA, diagnostic string) work.PullRequestMergeResult {
	pr := work.PullRequest{
		Number:       state.Number,
		NodeID:       state.NodeID,
		State:        graphQLPullRequestState(state.State),
		HeadSHA:      state.HeadSHA,
		BaseSHA:      state.BaseSHA,
		Mergeability: graphQLMergeability(state.Mergeable),
	}
	if state.MergeCommit != nil {
		pr.MergeSHA = state.MergeCommit.SHA
	}

	if state.Merged && pr.MergeSHA != "" {
		return work.PullRequestMergeResult{Outcome: work.PullRequestMergeConfirmed, MergeSHA: pr.MergeSHA, PullRequest: pr}
	}
	if state.Merged {
		return work.PullRequestMergeResult{Outcome: work.PullRequestMergeRetryableAmbiguity, PullRequest: pr, Diagnostic: "github reported merged without a merge commit sha"}
	}
	if pr.State == work.PullRequestStateClosed {
		return work.PullRequestMergeResult{Outcome: work.PullRequestMergeClosedUnmerged, PullRequest: pr, Diagnostic: diagnostic}
	}
	if pr.HeadSHA != expectedHeadSHA {
		return work.PullRequestMergeResult{Outcome: work.PullRequestMergeHeadChanged, PullRequest: pr, Diagnostic: diagnostic}
	}
	if pr.Mergeability == work.PullRequestMergeabilityConflicting {
		return work.PullRequestMergeResult{Outcome: work.PullRequestMergeTextConflict, PullRequest: pr, Diagnostic: diagnostic}
	}
	if baseRefreshRequired(diagnostic) {
		return work.PullRequestMergeResult{Outcome: work.PullRequestMergeBaseRefreshRequired, PullRequest: pr, Diagnostic: diagnostic}
	}
	return work.PullRequestMergeResult{Outcome: work.PullRequestMergeRetryableAmbiguity, PullRequest: pr, Diagnostic: diagnostic}
}

func graphQLPullRequestState(state string) work.PullRequestState {
	switch state {
	case "OPEN":
		return work.PullRequestStateOpen
	case "CLOSED":
		return work.PullRequestStateClosed
	default:
		return ""
	}
}

func graphQLMergeability(mergeable string) work.PullRequestMergeability {
	switch mergeable {
	case "MERGEABLE":
		return work.PullRequestMergeabilityMergeable
	case "CONFLICTING":
		return work.PullRequestMergeabilityConflicting
	default:
		return work.PullRequestMergeabilityUnknown
	}
}

func mergeMessage(err error, result *gh.PullRequestMergeResult) string {
	if result != nil && result.GetMessage() != "" {
		return result.GetMessage()
	}
	var response *gh.ErrorResponse
	if errors.As(err, &response) {
		return response.Message
	}
	return ""
}

func baseRefreshRequired(diagnostic string) bool {
	diagnostic = strings.ToLower(diagnostic)
	return strings.Contains(diagnostic, "base branch was modified") ||
		strings.Contains(diagnostic, "base branch must be up to date") ||
		strings.Contains(diagnostic, "not up to date")
}
