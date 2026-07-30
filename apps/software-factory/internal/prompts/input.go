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

type reviewInput struct{ Plan work.StageOutput }

func (in reviewInput) templateValues() (map[string]string, error) {
	if strings.TrimSpace(in.Plan.Prose()) == "" {
		return nil, missingPrior(work.StageReview, work.StagePlan)
	}
	return map[string]string{"plan": in.Plan.Prose()}, nil
}

type reviseInput struct{ Plan, Review work.StageOutput }

func (in reviseInput) templateValues() (map[string]string, error) {
	if strings.TrimSpace(in.Plan.Prose()) == "" {
		return nil, missingPrior(work.StageRevise, work.StagePlan)
	}
	if strings.TrimSpace(in.Review.Prose()) == "" {
		return nil, missingPrior(work.StageRevise, work.StageReview)
	}
	return map[string]string{"plan": in.Plan.Prose(), "review": in.Review.Prose()}, nil
}

type implementInput struct{ RevisedPlan work.StageOutput }

func (in implementInput) templateValues() (map[string]string, error) {
	if strings.TrimSpace(in.RevisedPlan.Prose()) == "" {
		return nil, missingPrior(work.StageImplement, work.StageRevise)
	}
	return map[string]string{"revised_plan": in.RevisedPlan.Prose()}, nil
}

type proposeInput struct{ ImplementationReport work.StageOutput }

func (in proposeInput) templateValues() (map[string]string, error) {
	if strings.TrimSpace(in.ImplementationReport.Prose()) == "" {
		return nil, missingPrior(work.StagePropose, work.StageImplement)
	}
	return map[string]string{"implementation_report": in.ImplementationReport.Prose()}, nil
}

// buildStageInput selects and builds one stage's typed input from the run's
// prior outputs.
//
// prior is single-slot-per-stage, last-write-wins: today's pipeline runs each
// stage exactly once, so one StageOutput per Stage is the whole history. A
// loop that invokes a stage more than once — step 5's implement/review loop
// — will need per-turn history, not a single map slot, and that is a change
// to how prior is carried, not to this dispatch. Left as a marker for step
// 5's plan, not built here.
//
// Exhaustive, no default — matches stageTemplate.
func buildStageInput(stage work.Stage, prior map[work.Stage]work.StageOutput) (stageInput, error) {
	switch stage {
	case work.StagePlan:
		return planInput{}, nil
	case work.StageReview:
		return reviewInput{Plan: prior[work.StagePlan]}, nil
	case work.StageRevise:
		return reviseInput{Plan: prior[work.StagePlan], Review: prior[work.StageReview]}, nil
	case work.StageImplement:
		return implementInput{RevisedPlan: prior[work.StageRevise]}, nil
	case work.StagePropose:
		return proposeInput{ImplementationReport: prior[work.StageImplement]}, nil
	}
	return nil, fmt.Errorf("no input shape for stage %q", stage)
}
