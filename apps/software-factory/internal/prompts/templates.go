package prompts

import (
	"embed"
	"fmt"
	"strings"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// templates holds the prompt set and the output schema as files rather than Go
// string literals, so changing what a stage is told is a markdown edit that
// reviews as prose. See NOTES.md for what each one is for.
//
//go:embed templates/*.md templates/envelope.schema.json
var templates embed.FS

// baseTemplate is prefixed to every stage prompt. It carries the role, the
// output contract and the untrusted-issue fence; the stage file that follows it
// carries the task.
const baseTemplate = "templates/base.md"

// stageTemplate names the file holding one stage's own instructions.
//
// The switch is exhaustive and has no default: a sixth stage must be given a
// prompt here before it will compile.
func stageTemplate(stage work.Stage) (string, error) {
	switch stage {
	case work.StagePlan:
		return "templates/plan.md", nil
	case work.StageReview:
		return "templates/review.md", nil
	case work.StageRevise:
		return "templates/revise.md", nil
	case work.StageImplement:
		return "templates/implement.md", nil
	case work.StagePropose:
		return "templates/propose.md", nil
	}
	return "", fmt.Errorf("no prompt for stage %q: it is not a stage of this pipeline", stage)
}

// reads returns the earlier stages whose documents a stage's prompt
// interpolates, in the order the prompt presents them.
//
// This is the handoff graph, and it lives here because the templates are what
// define it: `review.md` asks for the plan, so review reads plan. A stage
// handed more than this is shown only what it asks for.
func reads(stage work.Stage) []work.Stage {
	switch stage {
	case work.StagePlan:
		return nil
	case work.StageReview:
		return []work.Stage{work.StagePlan}
	case work.StageRevise:
		return []work.Stage{work.StagePlan, work.StageReview}
	case work.StageImplement:
		return []work.Stage{work.StageRevise}
	case work.StagePropose:
		return []work.Stage{work.StageImplement}
	}
	return nil
}

// documentVar is the template variable a stage's document is interpolated as.
//
// Each is named for what its producing stage calls its own output — plan
// produces "the plan", revise produces "the revised plan" — so no stage refers
// to another's work by a name that stage does not use for itself.
func documentVar(produced work.Stage) (string, error) {
	switch produced {
	case work.StagePlan:
		return "plan", nil
	case work.StageReview:
		return "review", nil
	case work.StageRevise:
		return "revised_plan", nil
	case work.StageImplement:
		return "implementation_report", nil
	case work.StagePropose:
		// Nothing follows propose, so its document is never interpolated.
		return "", fmt.Errorf("the %s stage's document is read by no later stage", produced)
	}
	return "", fmt.Errorf("no document variable for stage %q", produced)
}

// interpolate substitutes `{{name}}` placeholders in a template.
//
// It is a substitution and not a template language, deliberately. Values are
// copied in whole and never rescanned, so issue text that happens to name a
// variable lands as those literal characters rather than choosing what goes
// into its own prompt.
//
// It is strict in both directions: a placeholder with no value, and a value
// with no placeholder, are both errors. That is what makes an edit to a
// markdown file that renames or drops a variable fail a test here rather than
// reach a model as the literal text `{{ticket_body}}`.
func interpolate(template string, values map[string]string) (string, error) {
	var out strings.Builder
	used := make(map[string]bool, len(values))

	rest := template
	for {
		before, after, found := strings.Cut(rest, "{{")
		out.WriteString(before)
		if !found {
			break
		}
		name, remainder, closed := strings.Cut(after, "}}")
		if !closed {
			return "", fmt.Errorf("unclosed placeholder %.20q in the template", "{{"+after)
		}
		value, ok := values[name]
		if !ok {
			return "", fmt.Errorf("the template asks for {{%s}}, which this stage has no value for", name)
		}
		out.WriteString(value)
		used[name] = true
		rest = remainder
	}

	for name := range values {
		if !used[name] {
			return "", fmt.Errorf("this stage has a value for {{%s}}, which the template does not ask for", name)
		}
	}
	return out.String(), nil
}
