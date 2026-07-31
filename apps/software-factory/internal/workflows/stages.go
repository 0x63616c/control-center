package workflows

import (
	"strings"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// The implement/review loop's two counters, named locally for the loop that
// counts against them. Both are aliases: work owns the values, because
// work.MaxStageInvocations is derived from them and the review prompt is
// rendered with MaxReviewTurns in it. See work.MaxReviewTurns.
const (
	maxImplementTurnsPerWindow = work.MaxImplementTurnsPerWindow
	maxReviewTurns             = work.MaxReviewTurns
)

// acts names the activity methods for workflow.ExecuteActivity. It is always
// nil: Temporal resolves an activity from the method's name, never by calling
// it, and a nil handle makes it impossible for workflow code to invoke one
// directly by accident.
var acts *activities.Activities

// SignalUpdateConfig carries a work.ConfigUpdate to a dispatcher. Nil fields
// mean leave alone, so one message serves a deploy pushing settings and a
// human pausing the system.
const SignalUpdateConfig = "update-config"

// observedFailures reads new activity results' precise identities, and
// converts a pre-versioned result's retained names during old-history replay.
func observedFailures(obs activities.ObserveCIOutput) []work.CheckFailure {
	if len(obs.RedFailures) > 0 {
		return obs.RedFailures
	}

	failures := make([]work.CheckFailure, 0, len(obs.RedChecks))
	for _, name := range obs.RedChecks {
		failures = append(failures, work.CheckFailure{Name: name})
	}
	return failures
}

// checkFailureNames makes a readable stall reason without exposing opaque CI
// fingerprints in a pull request comment.
func checkFailureNames(failures []work.CheckFailure) string {
	seen := make(map[string]struct{}, len(failures))
	names := make([]string, 0, len(failures))
	for _, failure := range failures {
		if _, ok := seen[failure.Name]; ok {
			continue
		}
		seen[failure.Name] = struct{}{}
		names = append(names, failure.Name)
	}
	return strings.Join(names, ", ")
}

// lastOutput returns the most recent output in a stage's turn history, or
// the zero work.StageOutput if the stage has not produced one yet.
func lastOutput(outputs []work.StageOutput) work.StageOutput {
	if len(outputs) == 0 {
		return work.StageOutput{}
	}
	return outputs[len(outputs)-1]
}

// narrowPrior reduces the loop's own full turn history down to exactly what
// one stage attempt's activity input is allowed to carry — see
// work.PriorTurns' own doc comment for why. The full history stays right
// here, in prior, this function's argument: it never itself crosses into an
// activity input, only the values this returns do.
//
// The review ledger is the one thing that travels per-turn rather than
// latest-only, compacted to finding lists and verified lists — bounded by
// work.MaxReviewTurns, where an implement ledger would not be. Implement's
// history is still narrowed to its latest turn.
func narrowPrior(prior map[work.Stage][]work.StageOutput) work.PriorTurns {
	var ledger []work.ReviewTurnRecord
	for i, out := range prior[work.StageReview] {
		review, ok := out.Value().(work.ReviewOutput)
		if !ok {
			continue
		}
		ledger = append(ledger, work.ReviewTurnRecord{
			Turn:     i + 1,
			Findings: review.Findings,
			Verified: review.Verified,
		})
	}
	return work.PriorTurns{
		Plan:            lastOutput(prior[work.StagePlan]),
		LatestImplement: lastOutput(prior[work.StageImplement]),
		LatestReview:    lastOutput(prior[work.StageReview]),
		ReviewLedger:    ledger,
	}
}
