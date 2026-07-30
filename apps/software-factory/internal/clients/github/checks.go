package github

import (
	"context"
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	gh "github.com/google/go-github/v78/github"
)

// ChecksForRef returns every check run GitHub has recorded against ref — a
// branch name, in this service's only caller — as one snapshot.
//
// It takes no view on whether the checks it returns have concluded or
// passed: Activities.ObserveCI is what polls this repeatedly, waiting for a
// concluded result or its own bound, and reduces the snapshot into
// concluded/green/red for the implement/review loop's progress-detection
// rules. This stays a single request per call, symmetric with
// PullRequestForBranch, rather than a client that polls internally — polling
// belongs to the activity, which owns the wait and the bound on it.
func (c *Client) ChecksForRef(ctx context.Context, ref string) ([]work.CheckRun, error) {
	op := fmt.Sprintf("listing check runs for %s", ref)

	opts := &gh.ListCheckRunsOptions{ListOptions: gh.ListOptions{PerPage: perPage}}

	var runs []work.CheckRun
	for {
		result, resp, err := c.api.Checks.ListCheckRunsForRef(ctx, c.owner, c.repo, ref, opts)
		if err != nil {
			return nil, classify(ctx, op, err)
		}
		for _, run := range result.CheckRuns {
			runs = append(runs, work.CheckRun{
				Name:       run.GetName(),
				Completed:  run.GetStatus() == "completed",
				Conclusion: run.GetConclusion(),
			})
		}
		if resp.NextPage == 0 {
			return runs, nil
		}
		opts.Page = resp.NextPage
	}
}
