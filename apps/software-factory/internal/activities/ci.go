package activities

import (
	"context"
	"fmt"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/sdk/activity"
)

// ciPollInterval is how often ObserveCI re-reads GitHub's check runs while
// waiting for them to conclude.
//
// Fifteen seconds: check runs settle over minutes, not seconds, so nothing is
// gained by polling faster than this, and this is comfortably above GitHub's
// own rate-limit budget for the traffic one ticket's run generates.
const ciPollInterval = 15 * time.Second

// ObserveCIInput asks whether CI has concluded for one run's branch.
type ObserveCIInput struct {
	// Branch is the run's own branch — the same one CloneRepo pushed and
	// FindPullRequest looks for a pull request on. Its check runs are what
	// this activity polls.
	Branch string

	// Bound is how long this activity polls before giving up and reporting
	// itself unobserved, rather than letting Temporal's own
	// StartToCloseTimeout cancel it. It must be set below the ActivityOptions
	// timeout the workflow calls this under, with margin: this activity
	// returns a normal, non-error result on running out of Bound, and an
	// activity killed by its own StartToCloseTimeout instead returns an error
	// — a workflow that relied on the latter would see a timeout where the
	// pipeline-rewrite spec's "CI observation" section says there must be a
	// value: Concluded: false, reported like any other outcome.
	Bound time.Duration
}

// ObserveCIOutput is what CI reported for one run's branch, reduced to
// exactly the three questions the implement/review loop's progress-detection
// rules need answered — see the pipeline-rewrite spec's "CI observation" and
// "The real stop condition" sections.
type ObserveCIOutput struct {
	// Concluded is whether every check run GitHub reported had reached
	// "completed" before Bound elapsed. False means genuinely unknown, not
	// red and not green — see the spec's "'Unobserved' means only this."
	Concluded bool

	// Green is meaningful only when Concluded is true: every check run's
	// conclusion counted as passing (work.CheckRun.Green).
	Green bool

	// RedChecks names every check that had concluded and did not count as
	// passing, when Concluded is true. Meaningless when Concluded is false —
	// an unobserved turn reports no red checks of its own and must not be
	// compared as though it had, per the spec's carry-forward rule.
	RedChecks []string
}

// ObserveCI polls GitHub's check runs for a branch until every one of them
// has concluded, or its own Bound elapses first.
//
// A single unpolled snapshot taken too early would read an in-flight CI run
// as neither green nor red, which is not one of this design's states — every
// return here is one of exactly three: green, red (naming which checks),
// or unobserved. It is deliberately not workflow code: the poll loop below
// uses a real clock and a real sleep, which is legal here and would corrupt
// replay inside internal/workflows.
func (a *Activities) ObserveCI(ctx context.Context, in ObserveCIInput) (ObserveCIOutput, error) {
	if in.Branch == "" {
		return ObserveCIOutput{}, fail(ctx, "observing CI", fmt.Errorf(
			"no branch to observe checks for: %w", work.ErrPermanent))
	}
	if in.Bound <= 0 {
		return ObserveCIOutput{}, fail(ctx, "observing CI", fmt.Errorf(
			"a non-positive poll bound would return unobserved without ever asking github: %w", work.ErrPermanent))
	}

	deadline := a.deps.Clock.Now().Add(in.Bound)
	log := activity.GetLogger(ctx)

	for {
		checks, err := a.deps.GitHub.ChecksForRef(ctx, in.Branch)
		if err != nil {
			return ObserveCIOutput{}, fail(ctx, fmt.Sprintf("observing CI for %s", in.Branch), err)
		}

		if concluded, out := reduceChecks(checks); concluded {
			return out, nil
		}

		if !a.deps.Clock.Now().Before(deadline) {
			log.Warn("CI did not conclude within this activity's poll bound; reporting unobserved",
				"branch", in.Branch, "bound", in.Bound)
			return ObserveCIOutput{Concluded: false}, nil
		}

		activity.RecordHeartbeat(ctx, "waiting for CI to conclude")
		if err := a.deps.Clock.Sleep(ctx, ciPollInterval); err != nil {
			return ObserveCIOutput{}, fail(ctx, fmt.Sprintf("observing CI for %s", in.Branch), err)
		}
	}
}

// reduceChecks turns one snapshot of check runs into this activity's result,
// or reports that the snapshot has nothing conclusive yet.
//
// No check runs at all is treated the same as some still pending: CI may not
// have started reporting yet, and that is exactly as inconclusive as a check
// run stuck "in_progress" — neither is one of the three states this design
// recognises.
func reduceChecks(checks []work.CheckRun) (concluded bool, out ObserveCIOutput) {
	if len(checks) == 0 {
		return false, ObserveCIOutput{}
	}

	var red []string
	for _, check := range checks {
		if !check.Completed {
			return false, ObserveCIOutput{}
		}
		if !check.Green() {
			red = append(red, check.Name)
		}
	}

	return true, ObserveCIOutput{Concluded: true, Green: len(red) == 0, RedChecks: red}
}
