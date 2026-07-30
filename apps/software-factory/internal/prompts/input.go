package prompts

import (
	"fmt"
	"strings"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// stageInput is what one stage's own fields contribute to its prompt, beyond
// the ticket and fence nonce every stage gets already. One type per stage:
// the contract is what the type declares, not an entry in a lookup table.
type stageInput interface {
	// templateValues returns this stage's own template placeholder values.
	templateValues() (map[string]string, error)
}

// missingPrior is the error every stageInput returns when the earlier
// stage's document it reads is not there — the run cannot skip a stage.
func missingPrior(reader, produced work.Stage) error {
	return fmt.Errorf("the %s stage reads the %s stage's document, and there is none: the run cannot skip a stage", reader, produced)
}

type planInput struct{}

func (planInput) templateValues() (map[string]string, error) {
	return map[string]string{}, nil
}

// implementInput is what one implement turn's prompt is rendered from: the
// plan every turn reads, plus two documents that only exist from the second
// turn a run reaches onward. Both declare their own absence on turn one
// rather than being omitted, so implement.md can carry one fixed set of
// placeholders regardless of which turn is rendering — see
// previousImplementReportProse and mostRecentReviewFindingsProse.
type implementInput struct {
	// Plan is the plan stage's output. Every turn reads it.
	Plan work.StageOutput

	// PreviousReport is this run's own previous implement turn's report — the
	// zero value on the first implement turn of the whole run. It exists
	// because implement's codex conversation is resumed turn to turn (see the
	// pipeline-rewrite spec's "Codex sessions"), but a workflow replay reads
	// this prompt fresh, so anything the previous turn said that later turns'
	// prompts depend on has to be handed forward as a document like any other,
	// not assumed to still be "in the model's head".
	PreviousReport work.StageOutput

	// MostRecentReview is the most recent review turn's output, if review has
	// run at all yet. A CI-window's first implement turn after a review that
	// raised blocking findings is the turn this matters for; every other turn
	// simply sees the same findings again, which is redundant but not wrong.
	MostRecentReview work.StageOutput
}

func (in implementInput) templateValues() (map[string]string, error) {
	if strings.TrimSpace(in.Plan.Prose()) == "" {
		return nil, missingPrior(work.StageImplement, work.StagePlan)
	}
	return map[string]string{
		"plan":                      in.Plan.Prose(),
		"previous_implement_report": previousImplementReportProse(in.PreviousReport),
		"review_findings":           findingsProse(in.MostRecentReview),
	}, nil
}

// previousImplementReportProse declares absence rather than leaving a blank
// section: a turn that does not know it is the first has no way to tell "no
// previous report" apart from "the previous report was lost".
func previousImplementReportProse(previous work.StageOutput) string {
	if strings.TrimSpace(previous.Prose()) == "" {
		return "(This is the first implement turn of this run: there is no previous report to continue from.)"
	}
	return previous.Prose()
}

// reviewInput is what one review turn's prompt is rendered from: the most
// recent implement turn's report, plus the previous review turn's findings —
// present from review's second turn onward, and declaring its own absence
// before then, for the reason implementInput's PreviousReport does.
type reviewInput struct {
	// Implementation is the most recent implement turn's output. Every review
	// turn reads it — review runs only once that turn's CI is green.
	Implementation work.StageOutput

	// PreviousReview is this run's own previous review turn's output, the zero
	// value on review's first turn. Every review turn is a fresh thread with no
	// memory of the last, so a finding id can only be kept stable across turns
	// by showing a turn what the last one raised — see the pipeline-rewrite
	// spec's "What a finding id is, and how sameness is determined."
	PreviousReview work.StageOutput
}

func (in reviewInput) templateValues() (map[string]string, error) {
	if strings.TrimSpace(in.Implementation.Prose()) == "" {
		return nil, missingPrior(work.StageReview, work.StageImplement)
	}
	return map[string]string{
		"implementation_report":    in.Implementation.Prose(),
		"previous_review_findings": findingsProse(in.PreviousReview),
	}, nil
}

// findingsProse renders a review turn's findings as prose for a later
// prompt to read, or declares that there is none to show. It reads out through
// the stageOutputValue interface's own concrete type rather than a bare
// string, because a finding's id and blocking bit — the fields sameness is
// judged on — live in work.ReviewOutput, not in the prose document.
//
// A zero-value StageOutput (no review has run yet) and a real review that
// raised nothing both take the "none to show" branch: the two happen to read
// identically to a later prompt, which is correct, since either way there is
// nothing to reuse an id against.
func findingsProse(out work.StageOutput) string {
	review, ok := out.Value().(work.ReviewOutput)
	if !ok || len(review.Findings) == 0 {
		return "(No findings to show: either review has not run yet this run, or its last turn raised none.)"
	}

	var b strings.Builder
	for _, f := range review.Findings {
		kind := "advisory"
		if f.Blocking {
			kind = "blocking"
		}
		fmt.Fprintf(&b, "- id=%s (%s): %s\n", f.ID, kind, f.Summary)
	}
	return b.String()
}

// buildStageInput selects and builds one stage's typed input from
// work.PriorTurns — already narrowed to each stage's own latest turn by the
// time it reaches here (see PriorTurns' own doc comment for why nothing
// wider ever crosses the activity boundary).
//
// Exhaustive, no default — matches stageTemplate.
func buildStageInput(stage work.Stage, prior work.PriorTurns) (stageInput, error) {
	switch stage {
	case work.StagePlan:
		return planInput{}, nil
	case work.StageImplement:
		return implementInput{
			Plan:             prior.Plan,
			PreviousReport:   prior.LatestImplement,
			MostRecentReview: prior.LatestReview,
		}, nil
	case work.StageReview:
		return reviewInput{
			Implementation: prior.LatestImplement,
			PreviousReview: prior.LatestReview,
		}, nil
	}
	return nil, fmt.Errorf("no input shape for stage %q", stage)
}
