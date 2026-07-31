package workflows

import (
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

func reviewTurn(document string, verified []string, findings ...work.Finding) work.StageOutput {
	return work.NewStageOutput(work.StageReview, work.ReviewOutput{
		Document: document, Findings: findings, Verified: verified,
	})
}

// TestNarrowPriorBuildsTheReviewLedgerInTurnOrder is the workflow half of the
// #535 fix: the loop holds every review turn, and this is where the bounded
// slice of them is cut for the activity input a review prompt is rendered
// from. Turn numbers are the position in that history, 1-indexed, because
// that is what the prompt prints beside each entry.
func TestNarrowPriorBuildsTheReviewLedgerInTurnOrder(t *testing.T) {
	t.Parallel()

	prior := map[work.Stage][]work.StageOutput{
		work.StageReview: {
			reviewTurn("first", []string{"index.ts: accurate"},
				work.Finding{ID: "docs/stale", Blocking: true, Summary: "one"}),
			reviewTurn("second", nil,
				work.Finding{ID: "relay/drop", Blocking: true, Summary: "two"}),
		},
	}

	got := narrowPrior(prior).ReviewLedger
	if len(got) != 2 {
		t.Fatalf("ledger has %d entries, want one per review turn", len(got))
	}
	if got[0].Turn != 1 || got[1].Turn != 2 {
		t.Errorf("ledger turns = %d, %d; want 1, 2 oldest first", got[0].Turn, got[1].Turn)
	}
	if len(got[0].Findings) != 1 || got[0].Findings[0].ID != "docs/stale" {
		t.Errorf("turn 1 findings = %+v, want the finding that turn raised", got[0].Findings)
	}
	if len(got[0].Verified) != 1 {
		t.Errorf("turn 1 verified = %+v, want what that turn said it would keep", got[0].Verified)
	}
	if len(got[1].Verified) != 0 {
		t.Errorf("turn 2 verified = %+v, want nothing: that turn named nothing", got[1].Verified)
	}
}

// TestNarrowPriorHasNoLedgerBeforeReviewHasRun: every plan turn and every
// first-window implement turn narrows a history with no review in it, and an
// empty ledger has to stay empty rather than become a one-entry ledger of a
// zero StageOutput.
func TestNarrowPriorHasNoLedgerBeforeReviewHasRun(t *testing.T) {
	t.Parallel()

	prior := map[work.Stage][]work.StageOutput{
		work.StageImplement: {work.NewStageOutput(work.StageImplement, work.ImplementOutput{Report: "r"})},
	}
	if got := narrowPrior(prior).ReviewLedger; len(got) != 0 {
		t.Errorf("ReviewLedger = %+v, want empty before review has run", got)
	}
}

// TestNarrowPriorStillCarriesOnlyTheLatestImplementTurn is the invariant the
// ledger must not have loosened. Implement runs up to
// MaxImplementTurnsPerWindow*MaxReviewTurns times carrying a full report
// each; a ledger of those is the O(N^2) workflow history work.PriorTurns
// exists to prevent, which is why only review, hard-capped at
// MaxReviewTurns, gets one.
func TestNarrowPriorStillCarriesOnlyTheLatestImplementTurn(t *testing.T) {
	t.Parallel()

	prior := map[work.Stage][]work.StageOutput{
		work.StageImplement: {
			work.NewStageOutput(work.StageImplement, work.ImplementOutput{Report: "first"}),
			work.NewStageOutput(work.StageImplement, work.ImplementOutput{Report: "latest"}),
		},
	}

	narrowed := narrowPrior(prior)
	if got := narrowed.LatestImplement.Prose(); got != "latest" {
		t.Errorf("LatestImplement = %q, want the most recent turn", got)
	}
	if work.MaxImplementTurnsPerWindow*work.MaxReviewTurns <= work.MaxReviewTurns {
		t.Fatal("implement is no longer the stage with more turns than review; re-derive which one may hold a ledger")
	}
}
