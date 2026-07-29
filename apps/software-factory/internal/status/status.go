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
	"net/url"
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
	// is still what a human needs to find the run by hand. A value that is not
	// a URL this renderer will emit renders the same way — see linkedURL.
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
		field("Reason", inert(s.Reason, "_none given_")),
	)
}

// Proposed is the run's last comment when it opened a pull request.
type Proposed struct {
	RunID string
	// PullRequestURL is the pull request the run opened. It is untrusted: the
	// propose stage lifts it from the agent's own result file, which is model
	// output derived from issue text an attacker chose. It is rendered as
	// markup only if it survives linkedURL, and inertly otherwise.
	PullRequestURL string

	EndedAt time.Time

	// RunUsage is every stage's tokens summed, including stages that failed.
	RunUsage work.Usage
}

// Body renders the outcome comment for a run that proposed a change.
func (p Proposed) Body() string {
	return join(
		work.StatusMarker(p.RunID, work.StepOutcome),
		"### software-factory opened a pull request",
		"",
		pullRequestRef(p.PullRequestURL),
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
		field("Reason", inert(a.Reason, "_none given_")),
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
//
// The run URL is not held to pullRequestHost: it is operator config, and its
// host is whatever the Temporal UI is eventually published on.
func runRef(runID, runURL string) string {
	if _, ok := linkedURL(runURL); !ok {
		return code(runID)
	}
	return "[" + code(runID) + "](" + runURL + ")"
}

// pullRequestHost is the only host this renderer will emit a pull request link
// for.
//
// PullRequestURL is model output — the propose stage lifts it from the agent's
// own result file, and that agent read issue text an attacker chose — so a
// well-formed URL is not enough. Without this, `https://evil.example/pull/999`
// is a working link on a comment carrying this service's name, and a reader has
// been handed it by something they have reason to trust.
//
// This is a backstop, not the real fix. The real fix is that the propose stage
// records the URL the GitHub API returned when it created the pull request,
// rather than the one the model wrote; see the ticket referenced from the
// package's PR. Until then this fails closed to the inert rendering below.
const pullRequestHost = "github.com"

// pullRequestRef renders the pull request a run opened.
//
// A URL that does not survive linkedURL is still shown, but inertly: the value
// is the one thing a reader needs in order to work out what the propose stage
// actually produced, and dropping it would leave a comment announcing a pull
// request with no way to find out which one it meant or why it is missing.
//
// Inertly means inside a code span, via inert, which collapses whitespace and
// caps the text at maxReasonRunes. A pathological value is therefore shown
// truncated: the reader gets a lead on what propose produced, not a verbatim
// copy of it.
func pullRequestRef(rawURL string) string {
	if parsed, ok := linkedURL(rawURL); ok && parsed.Host == pullRequestHost {
		return rawURL
	}
	return inert(rawURL, "_no pull request URL was recorded_")
}

// linkedURL parses rawURL and reports whether it is a URL this renderer will
// emit as markup at all. The parsed form is returned so a caller can hold it to
// more than syntax — see pullRequestHost.
//
// Three separate things are refused, and each is refused on its own so that
// none of them can be deleted without a test noticing.
//
// A scheme other than http or https is a link a reader should not be handed —
// `javascript:` most obviously, but the point is the allowlist and not the
// example. Userinfo is refused outright rather than tolerated: in
// `https://github.com@evil.example/x` the part before the `@` is what a human
// reads as the host and the part after it is where the link goes, so a URL
// carrying any is either an attack or a mistake, and neither belongs in a
// comment this service signs. And any of the characters below breaks the markup
// the URL is about to sit inside: a single `)` closes the markdown link early
// and hands the rest of the value to the renderer, a newline puts
// attacker-chosen text on a line of its own where it reads as the run's own
// words, and `<` opens an HTML comment beside the marker that says which run a
// comment belongs to. None of them appear in a GitHub pull request URL or a
// Temporal history URL, so refusing all of them costs nothing real.
//
// A refusal is not an error. The caller decides what to show instead, because
// what a reader should see when a URL is unusable differs by which URL it was.
func linkedURL(rawURL string) (*url.URL, bool) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" {
		return nil, false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, false
	}
	if parsed.User != nil {
		return nil, false
	}
	if strings.ContainsFunc(rawURL, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r) || strings.ContainsRune("()<>[]`\"'", r)
	}) {
		return nil, false
	}
	return parsed, true
}

// inert renders untrusted text inside a code span, and falls back to absent
// when there is nothing left to render.
//
// The fallback is not cosmetic. cell strips whitespace, so a reason that
// arrived as spaces and a tab comes back empty, and an empty code span shows on
// GitHub as two literal backticks — which reads as a bug in this renderer
// rather than as the missing value it is.
func inert(text, absent string) string {
	if cleaned := cell(text); cleaned != "" {
		return code(cleaned)
	}
	return absent
}

// model names the model a stage ran on, and its reasoning effort when one was
// chosen. An unset effort renders as nothing rather than as empty parentheses,
// because "effort “" reads as a bug in the renderer.
//
// Both halves go through cell for the reason a failure reason does: they are
// hand-written config arriving over a Temporal signal, and a backtick in either
// closes the code span it sits in and hands the rest of the line to the
// markdown renderer.
func model(m work.Model) string {
	name := inert(m.Name, "_unnamed_")
	effort := cell(m.Effort)
	if effort == "" {
		return name
	}
	return fmt.Sprintf("%s (effort %s)", name, code(effort))
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
