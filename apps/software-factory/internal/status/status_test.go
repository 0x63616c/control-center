package status_test

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/status"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

var update = flag.Bool("update", false, "rewrite the golden files in testdata from the current renderers")

const (
	runID  = "019a3f2c-7b1e-4f9a-9c2d-3e5f6a7b8c9d"
	runURL = "https://temporal.example/namespaces/software-factory/workflows/work-ticket-331/019a3f2c-7b1e-4f9a-9c2d-3e5f6a7b8c9d/history"
)

var (
	pickedUpAt   = time.Date(2026, 7, 28, 18, 4, 5, 0, time.UTC)
	stageStartAt = time.Date(2026, 7, 28, 18, 4, 7, 0, time.UTC)
	stageEndAt   = time.Date(2026, 7, 28, 18, 7, 19, 0, time.UTC)
	runEndAt     = time.Date(2026, 7, 28, 18, 41, 2, 0, time.UTC)

	planModel = work.Model{Name: "gpt-5-codex", Effort: "high"}

	stageUsage = work.Usage{InputTokens: 41233, CachedInputTokens: 38000, OutputTokens: 5120, ReasoningTokens: 2048}
	runUsage   = work.Usage{InputTokens: 212845, CachedInputTokens: 190002, OutputTokens: 31004, ReasoningTokens: 12873}
)

func pickup() status.Pickup {
	return status.Pickup{RunID: runID, RunURL: runURL, StartedAt: pickedUpAt}
}

func started() status.StageStarted {
	return status.StageStarted{RunID: runID, Stage: work.StagePlan, Model: planModel, StartedAt: stageStartAt}
}

func succeeded() status.StageSucceeded {
	return status.StageSucceeded{
		RunID: runID, Stage: work.StagePlan, Model: planModel,
		StartedAt: stageStartAt, EndedAt: stageEndAt, Usage: stageUsage,
	}
}

func failed() status.StageFailed {
	return status.StageFailed{
		RunID: runID, Stage: work.StagePlan, Model: planModel,
		StartedAt: stageStartAt, EndedAt: stageEndAt, Usage: stageUsage,
		Reason: "codex exec exited 1: stage produced no result file",
	}
}

func proposed() status.Proposed {
	return status.Proposed{
		RunID:          runID,
		PullRequestURL: "https://github.com/0x63616c/world-wide-webb/pull/999",
		EndedAt:        runEndAt,
		RunUsage:       runUsage,
	}
}

func abandoned() status.Abandoned {
	return status.Abandoned{
		RunID:    runID,
		Reason:   "the review stage rejected the plan twice; no further attempt is worth the tokens",
		EndedAt:  runEndAt,
		RunUsage: runUsage,
	}
}

// bodies is every comment a run can post, by the golden file that holds it.
func bodies() map[string]string {
	noURL := pickup()
	noURL.RunURL = ""
	return map[string]string{
		"pickup.md":          pickup().Body(),
		"pickup-no-url.md":   noURL.Body(),
		"stage-started.md":   started().Body(),
		"stage-succeeded.md": succeeded().Body(),
		"stage-failed.md":    failed().Body(),
		"proposed.md":        proposed().Body(),
		"abandoned.md":       abandoned().Body(),
	}
}

func TestRendersEachCommentAsItsGoldenFile(t *testing.T) {
	for name, body := range bodies() {
		t.Run(name, func(t *testing.T) {
			assertGolden(t, name, body)
		})
	}
}

func TestOpensEveryCommentWithItsOwnMarker(t *testing.T) {
	t.Parallel()

	// The marker is line one or PostStatus cannot adopt the comment on retry,
	// and TicketDetail cannot filter our own updates out of the planner's
	// input.
	cases := []struct {
		name string
		body string
		want string
	}{
		{"pickup", pickup().Body(), work.StatusMarker(runID, work.StepPickup)},
		{"stage started", started().Body(), work.StatusMarker(runID, work.StageStep(work.StagePlan))},
		{"stage succeeded", succeeded().Body(), work.StatusMarker(runID, work.StageStep(work.StagePlan))},
		{"stage failed", failed().Body(), work.StatusMarker(runID, work.StageStep(work.StagePlan))},
		{"proposed", proposed().Body(), work.StatusMarker(runID, work.StepOutcome)},
		{"abandoned", abandoned().Body(), work.StatusMarker(runID, work.StepOutcome)},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, ok := work.StatusMarkerIn(tc.body)
			if !ok {
				t.Fatalf("no marker on the first line of:\n%s", tc.body)
			}
			if got != tc.want {
				t.Errorf("marker = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestKeepsAStagesMarkerStableFromStartToOutcome(t *testing.T) {
	t.Parallel()

	// A stage posts when it starts and edits that same comment when it ends. A
	// marker that changed on the way would leave the run editing a comment it
	// no longer identifies, and the reader with two.
	start, _ := work.StatusMarkerIn(started().Body())
	done, _ := work.StatusMarkerIn(succeeded().Body())
	broke, _ := work.StatusMarkerIn(failed().Body())

	if start != done || start != broke {
		t.Errorf("one stage renders three markers: started %q, succeeded %q, failed %q", start, done, broke)
	}
}

func TestGivesEveryCommentOfARunADistinctMarker(t *testing.T) {
	t.Parallel()

	// Every comment of one run, as the run posts them. Two sharing a marker
	// means the later post adopts the earlier comment and the audit trail this
	// format exists for loses an entry.
	markers := map[string]string{}
	add := func(name, body string) {
		t.Helper()
		marker, ok := work.StatusMarkerIn(body)
		if !ok {
			t.Fatalf("%s carries no marker", name)
		}
		if other, clash := markers[marker]; clash {
			t.Errorf("%s and %s share the marker %q", other, name, marker)
		}
		markers[marker] = name
	}

	add("pickup", pickup().Body())
	for _, stage := range work.Pipeline() {
		s := started()
		s.Stage = stage
		add("stage "+string(stage), s.Body())
	}
	add("outcome", proposed().Body())
}

func TestNamesEveryStageOfThePipelineWhenItPicksATicketUp(t *testing.T) {
	t.Parallel()

	// The pickup comment promises the reader what is coming. A stage added to
	// Pipeline and missing here is a run that silently does more than it said.
	body := pickup().Body()
	for _, stage := range work.Pipeline() {
		if !strings.Contains(body, "`"+string(stage)+"`") {
			t.Errorf("pickup comment does not name the %s stage:\n%s", stage, body)
		}
	}
}

func TestRendersEveryTimestampAsRFC3339UTC(t *testing.T) {
	t.Parallel()

	// A worker image without tzdata renders a zone it cannot load differently
	// from a developer's laptop, so golden files would pass locally and drift
	// in prod. UTC is the only rendering that cannot.
	tokyo := time.FixedZone("JST", 9*60*60)
	p := pickup()
	p.StartedAt = pickedUpAt.In(tokyo)

	if want := "`2026-07-28T18:04:05Z`"; !strings.Contains(p.Body(), want) {
		t.Errorf("pickup comment does not render %s in UTC:\n%s", want, p.Body())
	}
}

func TestReportsHowLongAStageTook(t *testing.T) {
	t.Parallel()

	if want := "`3m12s`"; !strings.Contains(succeeded().Body(), want) {
		t.Errorf("stage comment does not report a duration of %s:\n%s", want, succeeded().Body())
	}
}

func TestReportsNoDurationForAStageThatEndedBeforeItStarted(t *testing.T) {
	t.Parallel()

	// Clock skew between a heartbeat and a completion is not worth a negative
	// number in a human's face.
	s := succeeded()
	s.EndedAt = s.StartedAt.Add(-time.Minute)

	if strings.Contains(s.Body(), "-1m0s") {
		t.Errorf("stage comment reports a negative duration:\n%s", s.Body())
	}
	if want := "`0s`"; !strings.Contains(s.Body(), want) {
		t.Errorf("stage comment does not clamp the duration to %s:\n%s", want, s.Body())
	}
}

func TestKeepsFreeTextOnOneLineAndInsideItsCell(t *testing.T) {
	t.Parallel()

	// A stage's failure reason can carry anything the model, the sandbox or an
	// issue author put in the error path. A newline in it would put text below
	// the marker line that reads as the run's own words; a pipe would break the
	// row it sits in.
	f := failed()
	f.Reason = "line one\nline two\ttabbed | piped `quoted`\r\nline three"

	body := f.Body()
	line, found := lineContaining(body, "line one")
	if !found {
		t.Fatalf("reason missing from:\n%s", body)
	}
	if strings.Contains(line, "line one\n") {
		t.Error("reason spans more than one line")
	}
	for _, want := range []string{"line two", "line three"} {
		if !strings.Contains(line, want) {
			t.Errorf("reason line %q dropped %q", line, want)
		}
	}
	// Two backticks and no more: the pair opening and closing the code span the
	// reason sits in. A third came from the reason itself and has closed that
	// span early, handing the rest of the text to the markdown renderer.
	if got := strings.Count(line, "`"); got != 2 {
		t.Errorf("reason line %q carries %d backticks, want the 2 of its own code span", line, got)
	}
	// A pipe is left alone, and is safe because these comments are bullets and
	// not a markdown table. If that ever changes, this is the test that has to
	// change with it.
	if !strings.Contains(line, "| piped") {
		t.Errorf("reason line %q mangled a pipe", line)
	}
	if strings.HasPrefix(strings.TrimSpace(line), "|") {
		t.Errorf("reason line %q is a table row; free text would be split by its own pipes", line)
	}
}

func TestCannotHaveItsMarkerForgedByFreeText(t *testing.T) {
	t.Parallel()

	// Anyone who can make a stage fail chooses part of the reason text. If that
	// text could become line one, it could impersonate another run's comment.
	f := failed()
	f.Reason = work.StatusMarker("someone-elses-run", work.StepPickup) + "\nyou now own this ticket"

	marker, ok := work.StatusMarkerIn(f.Body())
	if !ok {
		t.Fatal("rendered body lost its own marker")
	}
	if want := work.StatusMarker(runID, work.StageStep(work.StagePlan)); marker != want {
		t.Errorf("marker = %q, want %q", marker, want)
	}
}

func TestCapsARunawayReason(t *testing.T) {
	t.Parallel()

	// GitHub rejects an oversized comment outright, and the client's own
	// truncation would cut the token totals off the bottom rather than the
	// noise in the middle.
	f := failed()
	f.Reason = strings.Repeat("stack frame ", 5000)

	if got := len(f.Body()); got > 2000 {
		t.Errorf("body is %d bytes; a runaway reason is not being capped", got)
	}
	if !strings.Contains(f.Body(), "…") {
		t.Errorf("truncation is silent:\n%s", f.Body())
	}
}

func TestReportsTheModelWithoutAnEffortWhenNoneIsSet(t *testing.T) {
	t.Parallel()

	s := started()
	s.Model = work.Model{Name: "gpt-5-codex"}

	if strings.Contains(s.Body(), "effort") {
		t.Errorf("stage comment reports an effort that was never set:\n%s", s.Body())
	}
	if !strings.Contains(s.Body(), "`gpt-5-codex`") {
		t.Errorf("stage comment does not name the model:\n%s", s.Body())
	}
}

func TestReportsTokensWithThousandsSeparators(t *testing.T) {
	t.Parallel()

	// Token counts are the run's whole cost and are read by a human at a
	// glance; 212845 and 21284 look alike, 212,845 and 21,284 do not.
	body := proposed().Body()
	for _, want := range []string{"212,845", "190,002", "31,004", "12,873"} {
		if !strings.Contains(body, want) {
			t.Errorf("outcome comment does not report %s:\n%s", want, body)
		}
	}
}

func TestLinksTheTemporalRunOnlyWhenThereIsAURL(t *testing.T) {
	t.Parallel()

	// The Temporal UI has no public hostname yet, so a run may have no URL to
	// offer. It still has to name its run — that is how a human finds it.
	linked := pickup().Body()
	if !strings.Contains(linked, "["+"`"+runID+"`"+"]("+runURL+")") {
		t.Errorf("pickup comment does not link the run:\n%s", linked)
	}

	bare := pickup()
	bare.RunURL = ""
	if strings.Contains(bare.Body(), "](") {
		t.Errorf("pickup comment invents a link with no URL:\n%s", bare.Body())
	}
	if !strings.Contains(bare.Body(), "`"+runID+"`") {
		t.Errorf("pickup comment without a URL does not name the run:\n%s", bare.Body())
	}
}

func lineContaining(body, want string) (string, bool) {
	for _, line := range strings.Split(body, "\n") {
		if strings.Contains(line, want) {
			return line, true
		}
	}
	return "", false
}

func assertGolden(t *testing.T, name, got string) {
	t.Helper()

	path := filepath.Join("testdata", name)
	if *update {
		if err := os.WriteFile(path, []byte(got), 0o600); err != nil {
			t.Fatalf("writing %s: %v", path, err)
		}
		return
	}

	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v (regenerate with: go test ./internal/status -update)", path, err)
	}
	if got != string(want) {
		t.Errorf("%s is stale.\n--- rendered ---\n%s\n--- golden ---\n%s", path, got, want)
	}
}

// The tests below name the semantic properties of the format. They exist
// because a golden file cannot: `assertGolden` ships a -update flag, so a
// golden is a snapshot of whatever the renderers currently do, and a reader who
// believes a failing golden is merely stale can regenerate the format's only
// written home in one command. What a comment MEANS — the order the pipeline
// runs in, which state word each renderer claims, which parts an outcome
// comment may never lose — is asserted here instead, where the intent is in the
// assertion rather than in a file that agrees with the code by construction.

func TestPromisesThePipelineInTheOrderItWillRun(t *testing.T) {
	t.Parallel()

	// Containment is not enough. The pickup comment is where a reader learns
	// what order the run executes in, so a reordered Pipeline that still names
	// every stage would leave the comment lying about the run rather than
	// merely incomplete.
	stages := work.Pipeline()
	names := make([]string, 0, len(stages))
	for _, stage := range stages {
		names = append(names, "`"+string(stage)+"`")
	}
	want := strings.Join(names, " → ")

	if !strings.Contains(pickup().Body(), want) {
		t.Errorf("pickup comment does not promise the pipeline as %q:\n%s", want, pickup().Body())
	}
}

func TestEachStageRenderingClaimsItsOwnState(t *testing.T) {
	t.Parallel()

	// The three stage bodies share a marker and therefore a comment: the run
	// posts one and edits it into the next. The heading is the only thing that
	// tells a reader which of the three they are looking at, so a rendering
	// that claimed another's state would report a failed stage as done on a
	// ticket somebody is about to act on.
	for _, tc := range []struct {
		name string
		body string
		want string
		deny []string
	}{
		{"started", started().Body(), "### plan — running", []string{"— done", "— failed"}},
		{"succeeded", succeeded().Body(), "### plan — done", []string{"— running", "— failed"}},
		{"failed", failed().Body(), "### plan — failed", []string{"— running", "— done"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if !strings.Contains(tc.body, tc.want) {
				t.Errorf("%s stage does not head its comment %q:\n%s", tc.name, tc.want, tc.body)
			}
			for _, unwanted := range tc.deny {
				if strings.Contains(tc.body, unwanted) {
					t.Errorf("%s stage also claims %q, so the heading no longer says which it is:\n%s",
						tc.name, unwanted, tc.body)
				}
			}
		})
	}
}

func TestEachCommentHeadsWithWhatActuallyHappened(t *testing.T) {
	t.Parallel()

	// Every comment of a run opens with a heading, and no two steps may share
	// one: the pickup heading on an outcome comment would tell a reader the run
	// is starting when it has just given up.
	headings := map[string]string{}
	for _, tc := range []struct{ name, body string }{
		{"pickup", pickup().Body()},
		{"proposed", proposed().Body()},
		{"abandoned", abandoned().Body()},
	} {
		heading, found := lineWithPrefix(tc.body, "### ")
		if !found {
			t.Fatalf("%s comment has no heading:\n%s", tc.name, tc.body)
		}
		if other, clash := headings[heading]; clash {
			t.Errorf("%s and %s both head their comment %q", other, tc.name, heading)
		}
		headings[heading] = tc.name
	}

	if !strings.Contains(proposed().Body(), "### software-factory opened a pull request") {
		t.Errorf("the proposed comment does not say a pull request was opened:\n%s", proposed().Body())
	}
	if !strings.Contains(abandoned().Body(), "### software-factory stopped without opening a pull request") {
		t.Errorf("the abandoned comment does not say the run stopped empty-handed:\n%s", abandoned().Body())
	}
}

func TestTheProposedCommentCarriesThePullRequestItOpened(t *testing.T) {
	t.Parallel()

	// The whole point of the run is in this one field. A comment announcing a
	// pull request and not linking it sends every reader to the PR list to
	// guess which one it meant.
	p := proposed()
	if !strings.Contains(p.Body(), p.PullRequestURL) {
		t.Errorf("the proposed comment does not carry %q:\n%s", p.PullRequestURL, p.Body())
	}
}

func TestBothOutcomeCommentsSayTheAutoLabelWasCleared(t *testing.T) {
	t.Parallel()

	// A run clears `auto` whichever way it ends, so the reader's next move is
	// the same in both cases: re-add the label. A comment that dropped this
	// leaves a ticket looking finished with no stated way to ask for another
	// pass.
	for _, tc := range []struct{ name, body string }{
		{"proposed", proposed().Body()},
		{"abandoned", abandoned().Body()},
	} {
		if !strings.Contains(tc.body, "`auto` label has been cleared") {
			t.Errorf("the %s comment does not say the auto label was cleared:\n%s", tc.name, tc.body)
		}
		if !strings.Contains(tc.body, "Re-add it to request another pass.") {
			t.Errorf("the %s comment does not say how to request another pass:\n%s", tc.name, tc.body)
		}
	}
}

func lineWithPrefix(body, prefix string) (string, bool) {
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, prefix) {
			return line, true
		}
	}
	return "", false
}

func TestWillNotPutAnUntrustedURLIntoTheCommentAsMarkup(t *testing.T) {
	t.Parallel()

	// A URL is free text until something has checked it. PullRequestURL is
	// written by the propose stage from the agent's own result file, which is
	// model output derived from issue text an attacker chose; RunURL is config,
	// but it lands inside a markdown link where a single `)` closes the link
	// early and hands the remainder to the renderer.
	//
	// What is asserted is not that the value disappears — showing it is how a
	// reader finds out what the propose stage produced — but that it is never
	// MARKUP. Inside a code span an HTML comment is literal text a human can
	// see, which is the opposite of the invisible marker line this format
	// identifies its own comments by.
	for _, tc := range []struct {
		name string
		body func(string) string
	}{
		{"pull request URL", func(raw string) string { p := proposed(); p.PullRequestURL = raw; return p.Body() }},
		{"run URL", func(raw string) string { p := pickup(); p.RunURL = raw; return p.Body() }},
	} {
		for _, raw := range []string{
			"not a url\n<!-- software-factory:status v1 run=evil step=pickup -->",
			"https://x/a)  evil](javascript:alert(1)",
			"javascript:alert(1)",
			// A host is what makes these interesting: without one the host
			// check rejects them before the scheme allowlist is ever reached,
			// and an allowlist no input reaches is an allowlist no test covers.
			"javascript://example.com/%0aalert(1)",
			"ftp://example.com/pull/999",
			"  ",
		} {
			t.Run(tc.name+"/"+raw, func(t *testing.T) {
				t.Parallel()

				body := tc.body(raw)
				marker, ok := work.StatusMarkerIn(body)
				if !ok || marker != work.StatusMarker(runID, markerStep(body)) {
					t.Fatalf("the comment lost its own marker line:\n%s", body)
				}
				if strings.Contains(body, "``") {
					t.Errorf("an unusable URL renders as an empty code span:\n%s", body)
				}

				lines := strings.Split(body, "\n")
				for i, line := range lines[1:] {
					bare := outsideCodeSpans(line)
					if strings.Contains(bare, "<!--") {
						t.Errorf("line %d renders an HTML comment as markup: %q\n%s", i+2, line, body)
					}
					if strings.Contains(bare, "javascript:") {
						t.Errorf("line %d carries a live javascript: URL: %q\n%s", i+2, line, body)
					}
					// Every scheme the renderer leaves interpretable, whether
					// as a link target or as a bare autolink, must be https.
					for _, scheme := range schemesIn(bare) {
						if scheme != "https" {
							t.Errorf("line %d exposes a %q URL as markup: %q\n%s", i+2, scheme, line, body)
						}
					}
					if strings.Count(bare, "(") != strings.Count(bare, ")") {
						t.Errorf("line %d has unbalanced markdown link syntax: %q\n%s", i+2, line, body)
					}
				}
			})
		}
	}
}

// markerStep is the step the body under test belongs to, so the assertion above
// compares against this run's real marker rather than merely a well-formed one.
func markerStep(body string) work.StatusStep {
	if strings.Contains(body, "picked up this ticket") {
		return work.StepPickup
	}
	return work.StepOutcome
}

// outsideCodeSpans is the part of a line the markdown renderer will interpret:
// everything not inside a pair of backticks.
func outsideCodeSpans(line string) string {
	parts := strings.Split(line, "`")
	var bare []string
	for i := 0; i < len(parts); i += 2 {
		bare = append(bare, parts[i])
	}
	return strings.Join(bare, "")
}

// schemesIn is every URL scheme a markdown renderer would act on in the part of
// a line that is not inside a code span — both `[text](scheme://…)` targets and
// bare autolinks, since GitHub linkifies the latter too.
func schemesIn(bare string) []string {
	var schemes []string
	for i := strings.Index(bare, "://"); i >= 0; i = strings.Index(bare, "://") {
		start := i
		for start > 0 && (unicode.IsLetter(rune(bare[start-1])) || unicode.IsDigit(rune(bare[start-1]))) {
			start--
		}
		schemes = append(schemes, bare[start:i])
		bare = bare[i+3:]
	}
	return schemes
}

func TestSaysSoRatherThanRenderingAnEmptyCodeSpan(t *testing.T) {
	t.Parallel()

	// A code span with nothing in it shows on GitHub as two literal backticks,
	// which reads as a renderer bug rather than as the absent value it is.
	// Nothing guarantees a failure arrives with words attached.
	for _, tc := range []struct{ name, body string }{
		{"abandoned reason", func() string { a := abandoned(); a.Reason = "   \n\t "; return a.Body() }()},
		{"failed reason", func() string { f := failed(); f.Reason = ""; return f.Body() }()},
		{"proposed pull request", func() string { p := proposed(); p.PullRequestURL = ""; return p.Body() }()},
	} {
		if strings.Contains(tc.body, "``") {
			t.Errorf("%s renders an empty code span:\n%s", tc.name, tc.body)
		}
	}
}

func TestRendersAModelNameDefensivelyToo(t *testing.T) {
	t.Parallel()

	// Config is hand-written and arrives over a Temporal signal. A backtick in
	// it closes the code span it sits in exactly the way one in a failure
	// reason does, one function away from where that is already defended.
	s := started()
	s.Model = work.Model{Name: "gpt`-5", Effort: "hi`gh"}

	line, found := lineContaining(s.Body(), "Model")
	if !found {
		t.Fatalf("no model row in:\n%s", s.Body())
	}
	if got := strings.Count(line, "`"); got != 4 {
		t.Errorf("model line %q carries %d backticks, want the 4 of its two code spans", line, got)
	}
}

// urlRenderer is one of the two places a URL reaches a comment, paired with a
// way to ask whether the rendered body treated that URL as markup.
//
// The question is deliberately "did it become markup", not "is it absent": an
// unusable URL is still shown, inside a code span, because the value is how a
// reader works out what the propose stage produced.
type urlRenderer struct {
	name string
	// markup renders a comment carrying raw and reports whether raw ended up
	// as live markup rather than inside a code span.
	markup func(raw string) bool
}

func urlRenderers() []urlRenderer {
	return []urlRenderer{
		{"pull request URL", func(raw string) bool {
			p := proposed()
			p.PullRequestURL = raw
			// pullRequestRef emits a vouched-for URL as a bare line, which
			// GitHub autolinks; anything else is wrapped in a code span.
			return strings.Contains(p.Body(), "\n"+raw+"\n")
		}},
		{"run URL", func(raw string) bool {
			p := pickup()
			p.RunURL = raw
			return strings.Contains(p.Body(), "]("+raw+")")
		}},
	}
}

func TestRefusesEachKindOfURLItCannotVouchFor(t *testing.T) {
	t.Parallel()

	// One input per clause of linkedURL, each chosen to trip that clause and
	// no other. An earlier version of this test had a single input carrying a
	// bad scheme, a bad character and no host at once: every clause but the
	// first was then unreachable, and three of the four could be deleted with
	// the suite still green. An input that trips two guards tests neither.
	for _, tc := range []struct {
		clause string
		raw    string
	}{
		{"no host", "https:pull/999"},
		{"scheme not http(s)", "ftp://example.com/pull/999"},
		{"userinfo, which puts a trusted-looking name in front of the real host", "https://github.com@evil.example/pull/999"},
		{"a parenthesis, which closes a markdown link early", "https://example.com/a(b)c"},
		{"an angle bracket, which opens an HTML comment", "https://example.com/a<b>c"},
		{"a square bracket, which opens a markdown link", "https://example.com/a[b]c"},
		{"a backtick, which closes the code span it may sit in", "https://example.com/a`b"},
		{"a quote, which closes an HTML attribute", "https://example.com/a\"b"},
		{"whitespace, which splits the value across the line", "https://example.com/a b"},
		{"a control character", "https://example.com/a\x00b"},
		{"a newline, which puts chosen text on a line of its own", "https://example.com/a\nb"},
	} {
		for _, renderer := range urlRenderers() {
			t.Run(renderer.name+"/"+tc.clause, func(t *testing.T) {
				t.Parallel()
				if renderer.markup(tc.raw) {
					t.Errorf("%q was rendered as markup; it carries %s", tc.raw, tc.clause)
				}
			})
		}
	}
}

func TestStillLinksAURLItCanVouchFor(t *testing.T) {
	t.Parallel()

	// The companion to the refusals above: without this, a linkedURL that
	// refused everything would pass every one of them.
	if !urlRenderers()[0].markup("https://github.com/0x63616c/world-wide-webb/pull/999") {
		t.Error("a github.com pull request URL is not rendered as a link")
	}
	if !urlRenderers()[1].markup(runURL) {
		t.Errorf("the Temporal run URL %q is not rendered as a link", runURL)
	}
}

func TestLinksOnlyAPullRequestOnGitHub(t *testing.T) {
	t.Parallel()

	// PullRequestURL is model output: the propose stage lifts it from the
	// agent's own result file, and that agent read issue text an attacker
	// chose. A well-formed URL on a host of the attacker's choosing is a
	// working phishing link posted to a real ticket under this service's name,
	// so the host is checked and not merely the syntax.
	//
	// The run URL is deliberately not held to this: it is operator config and
	// its host is whatever the Temporal UI is eventually published on.
	for _, raw := range []string{
		"https://evil.example/0x63616c/world-wide-webb/pull/999",
		"https://github.example/0x63616c/world-wide-webb/pull/999",
		"https://notgithub.com/0x63616c/world-wide-webb/pull/999",
	} {
		p := proposed()
		p.PullRequestURL = raw
		if strings.Contains(p.Body(), "\n"+raw+"\n") {
			t.Errorf("%q was rendered as a link from a comment this service signs", raw)
		}
		if !strings.Contains(p.Body(), "`"+raw+"`") {
			t.Errorf("%q was dropped rather than shown inertly:\n%s", raw, p.Body())
		}
	}

	if !strings.Contains(pickup().Body(), "]("+runURL+")") {
		t.Error("the run URL is being held to the pull request host allowlist")
	}
}
