// Package status renders the comments a run posts on the ticket it is working:
// what it picked up, what each stage did, and what came of it.
//
// A run appends a comment per step rather than editing one comment for the
// whole run, so the ticket's timeline is the audit trail — a reader scrolling
// the issue sees what ran, in order, without opening Temporal. The cost is a
// noisier ticket, and it was accepted deliberately.
//
// Each step is its own type with its own Body, rather than one struct whose
// empty fields decide what it means. A stage that has finished carries a
// duration and token counts a stage that has just started cannot have, and a
// run that opened a PR carries a URL a run that gave up cannot. Spelling those
// as one type would put "which fields are set" in every reader's head and in
// every caller's hands.
//
// Nothing here reaches GitHub. A Body is a string, and posting or editing it is
// the GitHub client's business, which is what keeps this package's tests golden
// files rather than a fake HTTP server.
package status

import (
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// maxReasonRunes bounds free text — a stage's failure reason, or why a run gave
// up. The text can carry a whole stack trace, and the fields below it are the
// token totals, so an unbounded reason pushes the run's cost off the bottom of
// a comment GitHub has already truncated.
const maxReasonRunes = 300

// Pickup announces the run: it is the first comment a run posts, and the one a
// reader arriving at the ticket reads first.
type Pickup struct {
	RunID string

	// RunURL links the Temporal run. It is optional because the Temporal UI has
	// no public hostname today; empty renders the run ID as plain text, which
	// is still what a human needs to find the run by hand.
	RunURL string

	StartedAt time.Time
}

// Body renders the pickup comment.
func (p Pickup) Body() string {
	return join(
		work.StatusMarker(p.RunID, work.StepPickup),
		"### software-factory picked up this ticket",
		"",
		field("Run", runRef(p.RunID, p.RunURL)),
		field("Started", code(stamp(p.StartedAt))),
		field("Pipeline", pipeline()),
		"",
		"Each stage appends its own comment below, and edits it when the stage ends.",
	)
}

// StageStarted is a stage's comment as posted the moment the stage begins, so
// a human watching a run mid-flight can see which stage is burning tokens
// rather than inferring it from silence.
type StageStarted struct {
	RunID     string
	Stage     work.Stage
	Model     work.Model
	StartedAt time.Time
}

// Body renders the running stage's comment.
func (s StageStarted) Body() string {
	return join(
		stageMarker(s.RunID, s.Stage),
		heading(s.Stage, "running"),
		"",
		field("Started", code(stamp(s.StartedAt))),
		field("Model", model(s.Model)),
	)
}

// StageSucceeded replaces StageStarted's body in the same comment when the
// stage finishes, which is why it carries the start time too: the comment is
// rewritten whole, not appended to.
type StageSucceeded struct {
	RunID     string
	Stage     work.Stage
	Model     work.Model
	StartedAt time.Time
	EndedAt   time.Time
	Usage     work.Usage
}

// Body renders the finished stage's comment.
func (s StageSucceeded) Body() string {
	return join(
		stageMarker(s.RunID, s.Stage),
		heading(s.Stage, "done"),
		"",
		field("Started", code(stamp(s.StartedAt))),
		field("Finished", code(stamp(s.EndedAt))),
		field("Duration", code(took(s.StartedAt, s.EndedAt))),
		field("Model", model(s.Model)),
		field("Tokens", tokens(s.Usage)),
	)
}

// StageFailed replaces StageStarted's body when the stage did not finish.
//
// It carries the same token counts a success does: a stage that failed still
// spent the quota, and a run's total is wrong without it.
type StageFailed struct {
	RunID     string
	Stage     work.Stage
	Model     work.Model
	StartedAt time.Time
	EndedAt   time.Time
	Usage     work.Usage

	// Reason is why the stage failed, in whatever words the failure arrived
	// with. It is rendered defensively — see cell.
	Reason string
}

// Body renders the failed stage's comment.
func (s StageFailed) Body() string {
	return join(
		stageMarker(s.RunID, s.Stage),
		heading(s.Stage, "failed"),
		"",
		field("Started", code(stamp(s.StartedAt))),
		field("Finished", code(stamp(s.EndedAt))),
		field("Duration", code(took(s.StartedAt, s.EndedAt))),
		field("Model", model(s.Model)),
		field("Tokens", tokens(s.Usage)),
		field("Reason", code(cell(s.Reason))),
	)
}

// Proposed is the run's last comment when it opened a pull request.
type Proposed struct {
	RunID          string
	PullRequestURL string
	EndedAt        time.Time

	// RunUsage is every stage's tokens summed, including stages that failed.
	RunUsage work.Usage
}

// Body renders the outcome comment for a run that proposed a change.
func (p Proposed) Body() string {
	return join(
		work.StatusMarker(p.RunID, work.StepOutcome),
		"### software-factory opened a pull request",
		"",
		p.PullRequestURL,
		"",
		field("Finished", code(stamp(p.EndedAt))),
		field("Run total", tokens(p.RunUsage)),
		"",
		autoLabelNote,
	)
}

// Abandoned is the run's last comment when it stopped without a pull request.
type Abandoned struct {
	RunID string

	// Reason is why the run stopped. It is rendered defensively — see cell.
	Reason  string
	EndedAt time.Time

	// RunUsage is every stage's tokens summed. A run that gave up still cost
	// something, and that is the number worth seeing when deciding whether to
	// ask it to try again.
	RunUsage work.Usage
}

// Body renders the outcome comment for a run that gave up.
func (a Abandoned) Body() string {
	return join(
		work.StatusMarker(a.RunID, work.StepOutcome),
		"### software-factory stopped without opening a pull request",
		"",
		field("Reason", code(cell(a.Reason))),
		field("Finished", code(stamp(a.EndedAt))),
		field("Run total", tokens(a.RunUsage)),
		"",
		autoLabelNote,
	)
}

// autoLabelNote closes both outcome comments. The run clears `auto` when it
// finishes either way, so the reader's next move is the same in both cases and
// is worth stating where they are looking.
const autoLabelNote = "The `auto` label has been cleared. Re-add it to request another pass."

// join assembles a comment body from its lines. Bodies are built as lines
// rather than written into a strings.Builder so that no step of rendering can
// return an error a caller has to think about.
func join(parts ...string) string {
	return strings.Join(parts, "\n") + "\n"
}

// field renders one labelled line of a comment.
//
// Bullets rather than a markdown table, deliberately: a table cell is split by
// a bare pipe, and free text in these comments comes from stack traces and
// model output. Bullets have no such character, so rendering cannot be steered
// by what a failure happened to say.
func field(label, value string) string {
	return "- **" + label + "** — " + value
}

// heading names the stage a comment belongs to and where that stage stands.
func heading(stage work.Stage, state string) string {
	return "### " + string(stage) + " — " + state
}

// stageMarker is the marker shared by a stage's started, succeeded and failed
// renderings. They are three bodies of one comment, so they must open with one
// marker: the run posts the first and edits it into whichever of the other two
// the stage earns.
func stageMarker(runID string, stage work.Stage) string {
	return work.StatusMarker(runID, work.StageStep(stage))
}

// pipeline lists the stages a reader should expect, in the order they run.
func pipeline() string {
	stages := work.Pipeline()
	names := make([]string, 0, len(stages))
	for _, stage := range stages {
		names = append(names, code(string(stage)))
	}
	return strings.Join(names, " → ")
}

// runRef names the Temporal run, linked when there is somewhere to link to.
func runRef(runID, runURL string) string {
	if runURL == "" {
		return code(runID)
	}
	return "[" + code(runID) + "](" + runURL + ")"
}

// model names the model a stage ran on, and its reasoning effort when one was
// chosen. An unset effort renders as nothing rather than as empty parentheses,
// because "effort ``" reads as a bug in the renderer.
func model(m work.Model) string {
	if m.Effort == "" {
		return code(m.Name)
	}
	return fmt.Sprintf("%s (effort %s)", code(m.Name), code(m.Effort))
}

// tokens renders one stage's or one run's token accounting.
func tokens(u work.Usage) string {
	return fmt.Sprintf("in %s (%s cached) · out %s · reasoning %s",
		code(commas(u.InputTokens)),
		code(commas(u.CachedInputTokens)),
		code(commas(u.OutputTokens)),
		code(commas(u.ReasoningTokens)),
	)
}

// stamp renders a time the way everything on the wire here does: RFC3339 UTC.
//
// UTC rather than the reader's own zone because the worker image carries no
// tzdata, so a local rendering would differ between a developer's machine and
// prod — and the golden files below would pass in exactly the place the bug
// could not be seen.
func stamp(t time.Time) string {
	return t.UTC().Format(time.RFC3339)
}

// took renders how long a stage ran, to the second.
//
// A stage that appears to end before it started is clamped to zero. The two
// timestamps can come from different observations of the clock, and a negative
// duration in a status comment reads as a bug in the run rather than as the
// rounding artefact it is.
func took(start, end time.Time) string {
	elapsed := end.Sub(start).Round(time.Second)
	if elapsed < 0 {
		elapsed = 0
	}
	return elapsed.String()
}

// code wraps a value in a markdown code span.
func code(value string) string {
	return "`" + value + "`"
}

// cell makes free text safe to render inside a code span on one line.
//
// The text is the tail of an error and can carry anything a model, a sandbox or
// an issue author put there. Two properties matter and neither is cosmetic: it
// must not introduce a newline, because a line of its own below the marker
// reads as the run's own words and could impersonate another run's marker; and
// it must not carry a backtick, because that closes the code span it sits in
// and hands the rest of the string to the markdown renderer.
func cell(text string) string {
	var out []rune
	pendingSpace := false
	truncated := false

	for _, r := range text {
		if unicode.IsSpace(r) {
			pendingSpace = len(out) > 0
			continue
		}
		if len(out) >= maxReasonRunes {
			truncated = true
			break
		}
		if pendingSpace {
			out = append(out, ' ')
			pendingSpace = false
		}
		if r == '`' {
			r = '\''
		}
		out = append(out, r)
	}

	if truncated {
		return string(out) + "…"
	}
	return string(out)
}

// commas groups a token count in threes, because these numbers are read at a
// glance and 212845 and 21284 do not look different at a glance.
func commas(n int64) string {
	digits := strconv.FormatInt(n, 10)
	sign := ""
	if strings.HasPrefix(digits, "-") {
		sign, digits = "-", digits[1:]
	}

	var out []byte
	for i := range len(digits) {
		if i > 0 && (len(digits)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, digits[i])
	}
	return sign + string(out)
}
