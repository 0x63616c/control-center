package status_test

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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
