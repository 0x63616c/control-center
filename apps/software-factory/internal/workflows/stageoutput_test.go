package workflows_test

import (
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// acts is a nil handle used only to name activity methods for the test
// environment's mocks. Nothing is ever called on it.
var acts *activities.Activities

// planOutput, implementOutput and reviewOutput build one turn's activity
// result, one per stage, since each answers in its own work.StageOutput
// shape. RunPlanOutput/RunImplementOutput/RunReviewOutput each embed an
// unexported stageOutput, so a value cannot be built with a struct literal
// from outside internal/activities — only its promoted exported fields
// (Output, Result, ThreadID, Usage) are reachable from here, which is enough
// to build one field by field.

// Pointers, not values: RunPlan/RunImplement/RunReview return
// *RunPlanOutput/*RunImplementOutput/*RunReviewOutput and nil on error (#457
// — a value return is never a nil pointer, so the SDK always tries to encode
// it, even on an error path where the embedded work.StageOutput is the zero
// value on purpose and refuses to marshal, silently replacing the real error
// with an encode failure). testify's mock checks the registered return
// against the activity's actual signature, so these have to match it.

func planOutput() *activities.RunPlanOutput {
	var out activities.RunPlanOutput
	fillStageOutput(&out.Output, &out.Result, &out.ThreadID, &out.Usage,
		work.NewStageOutput(work.StagePlan, work.DocumentOutput{Document: "the plan"}))
	out.Transcript = transcriptFor(work.StagePlan)
	return &out
}

func implementOutput(blocked bool, blockedReason, title, body string) *activities.RunImplementOutput {
	var out activities.RunImplementOutput
	fillStageOutput(&out.Output, &out.Result, &out.ThreadID, &out.Usage,
		work.NewStageOutput(work.StageImplement, work.ImplementOutput{
			Report: "implemented it", Blocked: blocked, BlockedReason: blockedReason, Title: title, Body: body,
		}))
	out.Transcript = transcriptFor(work.StageImplement)
	return &out
}

// reviewOutput builds one review turn's result: what it raised, and the
// "checked and would keep" list a later turn reads out of the review ledger.
func reviewOutput(verified []string, findings ...work.Finding) *activities.RunReviewOutput {
	var out activities.RunReviewOutput
	fillStageOutput(&out.Output, &out.Result, &out.ThreadID, &out.Usage,
		work.NewStageOutput(work.StageReview, work.ReviewOutput{
			Document: "the review", Findings: findings, Verified: verified,
		}))
	out.Transcript = transcriptFor(work.StageReview)
	return &out
}

// fillStageOutput fills in the fields every *Output type promotes from its
// embedded stageOutput, so the three constructors above share one body
// rather than repeating it.
func fillStageOutput(output *[]byte, result *work.StageOutput, threadID *string, usage *work.Usage, value work.StageOutput) {
	*output = []byte(fmt.Sprintf(`{"result":%q}`, value.Stage()))
	*result = value
	*threadID = "thread-" + string(value.Stage())
	*usage = work.Usage{InputTokens: 10, OutputTokens: 1}
}

// transcriptFor is the transcript planOutput/implementOutput/reviewOutput
// leave on a turn's output, so a test asserting the transcript was relayed
// has a fixed value to compare against without reaching into the promoted
// field it can't build a literal against directly.
func transcriptFor(stage work.Stage) work.Transcript {
	return work.Transcript(fmt.Sprintf(`{"type":"turn.completed","stage":%q}`, stage))
}

// red returns a concluded, red ObserveCIOutput with deterministic failure
// identities. Callers that need a same check name with different failures use
// redFailure directly.
func red(checks ...string) activities.ObserveCIOutput {
	failures := make([]work.CheckFailure, 0, len(checks))
	for _, check := range checks {
		failures = append(failures, work.CheckFailure{Name: check, Fingerprint: check + "-failure"})
	}
	return activities.ObserveCIOutput{Concluded: true, Green: false, RedChecks: checks, RedFailures: failures}
}

func redFailure(name, fingerprint string) activities.ObserveCIOutput {
	return activities.ObserveCIOutput{Concluded: true, Green: false, RedChecks: []string{name}, RedFailures: []work.CheckFailure{{Name: name, Fingerprint: fingerprint}}}
}

// green is a concluded, passing ObserveCIOutput.
func green() activities.ObserveCIOutput {
	return activities.ObserveCIOutput{Concluded: true, Green: true}
}
