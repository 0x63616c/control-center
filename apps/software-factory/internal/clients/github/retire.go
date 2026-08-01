package github

import (
	"context"
	"fmt"

	gh "github.com/google/go-github/v78/github"
)

// RetirePullRequest closes an unmerged predecessor pull request before a
// successor Run creates its own. It is idempotent and never closes a merge.
func (c *Client) RetirePullRequest(ctx context.Context, number int) (bool, error) {
	if number <= 0 {
		return false, fmt.Errorf("retiring pull request: pull request number is required")
	}
	state, err := c.pullRequestMergeState(ctx, number)
	if err != nil {
		return false, fmt.Errorf("reading pull request #%d before retirement: %w", number, err)
	}
	if state.Merged {
		return true, nil
	}
	if state.State == "CLOSED" {
		return false, nil
	}
	if state.State != "OPEN" {
		return false, fmt.Errorf("retiring pull request #%d: unexpected state %q", number, state.State)
	}
	if _, _, err := c.api.PullRequests.Edit(ctx, c.owner, c.repo, number, &gh.PullRequest{State: gh.Ptr("closed")}); err != nil {
		return false, classify(ctx, fmt.Sprintf("closing canceled pull request #%d", number), err)
	}
	confirmed, err := c.pullRequestMergeState(ctx, number)
	if err != nil {
		return false, fmt.Errorf("confirming retirement of pull request #%d: %w", number, err)
	}
	return confirmed.Merged, nil
}
