package prompts

import (
	"crypto/rand"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// newTestRenderer builds a renderer on real entropy. Nothing in these tests
// depends on which nonce it mints; the tests that do use fixedEntropy.
func newTestRenderer(t *testing.T) *Renderer {
	t.Helper()

	r, err := New(rand.Reader)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return r
}

// ticket is a detail with one comment, enough to exercise every field the base
// prompt interpolates.
func ticket() work.TicketDetail {
	return work.TicketDetail{
		Ticket: work.Ticket{
			Number: 329,
			Title:  "the three stage prompt templates",
			Body:   "Define what a plan, an implementation turn and a review turn each contain.",
		},
		Comments: []work.TicketComment{
			{Author: "0x63616c", Body: "keep it simple and let the agents do the heavy lifting"},
		},
	}
}

// stageOutputOf builds the StageOutput a stage produces for a given prose
// document: DocumentOutput for plan, ImplementOutput for implement, and
// ReviewOutput (with no findings) for review.
func stageOutputOf(stage work.Stage, doc string) work.StageOutput {
	switch stage {
	case work.StagePlan:
		return work.NewStageOutput(stage, work.DocumentOutput{Document: doc})
	case work.StageImplement:
		return work.NewStageOutput(stage, work.ImplementOutput{Report: doc})
	case work.StageReview:
		return work.NewStageOutput(stage, work.ReviewOutput{Document: doc})
	}
	return work.StageOutput{}
}

// everyDocument is one turn's output for every stage, so a test can render
// any stage without assembling the run's whole history itself. Each stage's
// history is one turn long here; TestRenderCarriesTheDocumentsAStageIsMeantToRead
// and buildStageInput's own tests build a longer history where a second turn
// matters.
func everyDocument() map[work.Stage][]work.StageOutput {
	return map[work.Stage][]work.StageOutput{
		work.StagePlan:      {stageOutputOf(work.StagePlan, "the plan document")},
		work.StageImplement: {stageOutputOf(work.StageImplement, "the implementation report document")},
		work.StageReview:    {stageOutputOf(work.StageReview, "the review document")},
	}
}

func TestRenderOpensWithTheBaseAndClosesWithTheStagePrompt(t *testing.T) {
	t.Parallel()

	r := newTestRenderer(t)

	for _, stage := range work.Pipeline() {
		t.Run(string(stage), func(t *testing.T) {
			t.Parallel()

			got, err := r.Render(Input{Stage: stage, Ticket: ticket(), Prior: everyDocument()})
			if err != nil {
				t.Fatalf("Render(%s): %v", stage, err)
			}

			base := strings.Index(got, "You are running as one stage of an autonomous pipeline")
			handoff := strings.Index(got, "Your instructions for this stage follow.")
			heading := strings.Index(got, "## Stage: "+string(stage))
			switch {
			case base != 0:
				t.Errorf("the base instructions are at index %d, want 0", base)
			case handoff < 0:
				t.Error("the base does not hand over to the stage prompt")
			case heading < handoff:
				t.Errorf("the %s stage prompt at %d precedes the handover at %d", stage, heading, handoff)
			}
		})
	}
}

func TestRenderLeavesNoPlaceholderUnfilled(t *testing.T) {
	t.Parallel()

	r := newTestRenderer(t)

	for _, stage := range work.Pipeline() {
		t.Run(string(stage), func(t *testing.T) {
			t.Parallel()

			got, err := r.Render(Input{Stage: stage, Ticket: ticket(), Prior: everyDocument()})
			if err != nil {
				t.Fatalf("Render(%s): %v", stage, err)
			}
			if i := strings.Index(got, "{{"); i >= 0 {
				t.Errorf("an unfilled placeholder reached the model: %.40q", got[i:])
			}
		})
	}
}

func TestRenderPutsEveryPieceOfTicketTextInsideTheFence(t *testing.T) {
	t.Parallel()

	r := newTestRenderer(t)
	detail := ticket()

	got, err := r.Render(Input{Stage: work.StagePlan, Ticket: detail, Prior: nil})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}

	fenced, ok := fencedText(t, got)
	if !ok {
		t.Fatal("the rendered prompt has no fence")
	}

	for _, want := range []string{
		detail.Title,
		detail.Body,
		detail.Comments[0].Author,
		detail.Comments[0].Body,
	} {
		if !strings.Contains(fenced, want) {
			t.Errorf("ticket text %q is not inside the fence", want)
		}
	}
	if !strings.Contains(got, "#329") {
		t.Error("the prompt does not name the issue it is for")
	}
}

// TestRenderCarriesTheDocumentsAStageIsMeantToRead exercises what each
// stage's own prompt actually surfaces, turn by turn: plan reads nothing;
// implement always reads the plan, plus its own previous turn's report and
// the most recent review's findings once those exist; review always reads
// the latest implement turn, plus the previous review's findings once one
// exists. "Findings" is prose the workflow-loop's progress detection cares
// about, rendered from work.Finding values — not review's raw Document —
// which is why these cases check for a finding's Summary rather than for a
// document string the way earlier turns' checks do.
func TestRenderCarriesTheDocumentsAStageIsMeantToRead(t *testing.T) {
	t.Parallel()

	r := newTestRenderer(t)

	t.Run("plan reads no prior document", func(t *testing.T) {
		t.Parallel()

		got, err := r.Render(Input{Stage: work.StagePlan, Ticket: ticket()})
		if err != nil {
			t.Fatalf("Render: %v", err)
		}
		if strings.Contains(got, documentTag) {
			t.Error("plan's prompt opens a document fence; plan reads no prior document")
		}
	})

	t.Run("implement's first turn", func(t *testing.T) {
		t.Parallel()

		prior := map[work.Stage][]work.StageOutput{
			work.StagePlan: {stageOutputOf(work.StagePlan, "the plan document")},
		}
		got, err := r.Render(Input{Stage: work.StageImplement, Ticket: ticket(), Prior: prior})
		if err != nil {
			t.Fatalf("Render: %v", err)
		}
		if !strings.Contains(got, "the plan document") {
			t.Error("implement's prompt does not carry the plan")
		}
		if !strings.Contains(got, "first implement turn") {
			t.Error("implement's first turn does not declare that it has no previous report to continue from")
		}
		if !strings.Contains(got, "No findings to show") {
			t.Error("implement's first turn does not declare that review has not run yet")
		}
	})

	t.Run("implement's later turn", func(t *testing.T) {
		t.Parallel()

		prior := map[work.Stage][]work.StageOutput{
			work.StagePlan:      {stageOutputOf(work.StagePlan, "the plan document")},
			work.StageImplement: {stageOutputOf(work.StageImplement, "turn one's own report")},
			work.StageReview: {work.NewStageOutput(work.StageReview, work.ReviewOutput{
				Document: "the review document",
				Findings: []work.Finding{{ID: "f1", Blocking: true, Summary: "fix the missing nil check"}},
			})},
		}
		got, err := r.Render(Input{Stage: work.StageImplement, Ticket: ticket(), Prior: prior})
		if err != nil {
			t.Fatalf("Render: %v", err)
		}
		if !strings.Contains(got, "the plan document") {
			t.Error("implement's prompt does not carry the plan")
		}
		if !strings.Contains(got, "turn one's own report") {
			t.Error("implement's later turn does not carry its own previous turn's report")
		}
		if !strings.Contains(got, "fix the missing nil check") {
			t.Error("implement's later turn does not carry the most recent review's findings")
		}
	})

	t.Run("review's first turn", func(t *testing.T) {
		t.Parallel()

		prior := map[work.Stage][]work.StageOutput{
			work.StageImplement: {stageOutputOf(work.StageImplement, "the implementation report")},
		}
		got, err := r.Render(Input{Stage: work.StageReview, Ticket: ticket(), Prior: prior})
		if err != nil {
			t.Fatalf("Render: %v", err)
		}
		if !strings.Contains(got, "the implementation report") {
			t.Error("review's prompt does not carry the latest implement turn's report")
		}
		if !strings.Contains(got, "No findings to show") {
			t.Error("review's first turn does not declare that there is no previous review to compare against")
		}
	})

	t.Run("review's later turn", func(t *testing.T) {
		t.Parallel()

		prior := map[work.Stage][]work.StageOutput{
			work.StageImplement: {stageOutputOf(work.StageImplement, "turn two's report")},
			work.StageReview: {work.NewStageOutput(work.StageReview, work.ReviewOutput{
				Document: "turn one's review",
				Findings: []work.Finding{{ID: "f1", Blocking: true, Summary: "still broken"}},
			})},
		}
		got, err := r.Render(Input{Stage: work.StageReview, Ticket: ticket(), Prior: prior})
		if err != nil {
			t.Fatalf("Render: %v", err)
		}
		if !strings.Contains(got, "turn two's report") {
			t.Error("review's prompt does not carry the latest implement turn's report")
		}
		if !strings.Contains(got, "still broken") {
			t.Error("review's later turn does not carry the previous review's own findings")
		}
	})
}

func TestRenderRefusesAStageWhoseInputDocumentIsMissing(t *testing.T) {
	t.Parallel()

	r := newTestRenderer(t)

	cases := []struct {
		name  string
		stage work.Stage
		prior map[work.Stage][]work.StageOutput
	}{
		{name: "review without any implement turn", stage: work.StageReview, prior: nil},
		{name: "implement without a plan", stage: work.StageImplement, prior: nil},
		{
			name:  "a blank plan is no plan",
			stage: work.StageImplement,
			prior: map[work.Stage][]work.StageOutput{work.StagePlan: {stageOutputOf(work.StagePlan, "   \n")}},
		},
		{
			name:  "a blank implementation report is no report",
			stage: work.StageReview,
			prior: map[work.Stage][]work.StageOutput{work.StageImplement: {stageOutputOf(work.StageImplement, "   \n")}},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			if _, err := r.Render(Input{Stage: tc.stage, Ticket: ticket(), Prior: tc.prior}); err == nil {
				t.Fatal("Render succeeded on a stage with nothing to read; the model would be handed an empty section")
			}
		})
	}
}

func TestRenderRefusesInputItCannotRender(t *testing.T) {
	t.Parallel()

	r := newTestRenderer(t)

	cases := []struct {
		name string
		in   Input
	}{
		{
			name: "a stage that is not in the pipeline",
			in:   Input{Stage: work.Stage("summarise"), Ticket: ticket(), Prior: everyDocument()},
		},
		{
			name: "no stage at all",
			in:   Input{Ticket: ticket(), Prior: everyDocument()},
		},
		{
			// The number is the identity of the whole run and is written into
			// the prompt as `#N`. Zero would render `#0`, which is an issue
			// that does not exist.
			name: "a ticket with no number",
			in:   Input{Stage: work.StagePlan, Ticket: work.TicketDetail{Ticket: work.Ticket{Title: "t", Body: "b"}}},
		},
		{
			name: "a ticket with no title",
			in:   Input{Stage: work.StagePlan, Ticket: work.TicketDetail{Ticket: work.Ticket{Number: 1, Body: "b"}}},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			if _, err := r.Render(tc.in); err == nil {
				t.Fatal("Render succeeded on input it cannot render")
			}
		})
	}
}

func TestRenderSaysWhenAThreadWasTrimmed(t *testing.T) {
	t.Parallel()

	r := newTestRenderer(t)
	detail := ticket()
	detail.CommentsOmitted = 12

	got, err := r.Render(Input{Stage: work.StagePlan, Ticket: detail})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	// The difference between a model knowing it lacks context and a model
	// believing it has all of it.
	if !strings.Contains(got, "12 comments") {
		t.Error("the prompt does not say the comment thread was trimmed")
	}
}

func TestRenderDeclaresAnAbsenceRatherThanLeavingABlank(t *testing.T) {
	t.Parallel()

	r := newTestRenderer(t)

	cases := []struct {
		name   string
		mutate func(*work.TicketDetail)
		want   string
	}{
		{
			name:   "an issue filed with no description",
			mutate: func(d *work.TicketDetail) { d.Body = "" },
			want:   "no description",
		},
		{
			name:   "an issue nobody has commented on",
			mutate: func(d *work.TicketDetail) { d.Comments = nil },
			want:   "no comments",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			detail := ticket()
			tc.mutate(&detail)

			got, err := r.Render(Input{Stage: work.StagePlan, Ticket: detail})
			if err != nil {
				t.Fatalf("Render: %v", err)
			}
			fenced, ok := fencedText(t, got)
			if !ok {
				t.Fatal("the rendered prompt has no fence")
			}
			if !strings.Contains(fenced, tc.want) {
				t.Errorf("the fence does not declare the absence; want text containing %q, got:\n%s", tc.want, fenced)
			}
		})
	}
}

func TestRenderDoesNotShareOneRunsPromptWithAnother(t *testing.T) {
	t.Parallel()

	r := newTestRenderer(t)
	in := Input{Stage: work.StagePlan, Ticket: ticket()}

	first, err := r.Render(in)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	second, err := r.Render(in)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if first == second {
		t.Error("two runs rendered byte-identical prompts, so the fence nonce is not per-run")
	}
}

// fencedText returns the text between the fence's opening and closing tags.
func fencedText(t *testing.T, rendered string) (string, bool) {
	t.Helper()

	_, open, ok := strings.Cut(rendered, "<"+fenceTag)
	if !ok {
		return "", false
	}
	_, body, ok := strings.Cut(open, ">\n")
	if !ok {
		return "", false
	}
	body, _, ok = strings.Cut(body, "</"+fenceTag)
	return body, ok
}

func TestRenderCapsHowMuchIssueTextOnePromptCarries(t *testing.T) {
	t.Parallel()

	r := newTestRenderer(t)

	// Fillers no template contains, so what is counted below is the issue's
	// text and nothing else.
	const (
		bodyFiller    = "qx"
		commentFiller = "zj"
	)

	// A GitHub issue body runs to 65536 characters and the seam carries 40
	// comments, so "the issue as its authors wrote it" is megabytes in the
	// worst case: an unbounded token spend, and a prompt that overflows the
	// context window before the stage's own instructions are read.
	comments := make([]work.TicketComment, 40)
	for i := range comments {
		comments[i] = work.TicketComment{Author: "drive-by", Body: strings.Repeat(commentFiller, 25_000)}
	}
	rendered, err := r.Render(Input{Stage: work.StagePlan, Ticket: work.TicketDetail{
		Ticket:   work.Ticket{Number: 1, Title: "t", Body: strings.Repeat(bodyFiller, 100_000)},
		Comments: comments,
	}})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}

	// Counted in units of the filler rather than in bytes of the whole prompt,
	// so the assertion is about the issue's text and not about how long the
	// templates happen to be.
	if got := len(bodyFiller) * strings.Count(rendered, bodyFiller); got > maxUntrustedBytes {
		t.Errorf("the prompt carries %d bytes of issue body, want at most %d", got, maxUntrustedBytes)
	}
	if got := len(commentFiller) * strings.Count(rendered, commentFiller); got > maxUntrustedBytes {
		t.Errorf("the prompt carries %d bytes of comment thread, want at most %d", got, maxUntrustedBytes)
	}
	// Cutting text out silently is the failure mode the trimmed-thread notice
	// already exists to avoid: a stage that does not know it was given part of
	// the issue will plan as though it had all of it.
	for _, want := range []string{"truncated", "not shown"} {
		if !strings.Contains(rendered, want) {
			t.Errorf("the prompt does not say text was cut (looked for %q)", want)
		}
	}
}

func TestRenderCarriesAnOrdinaryIssueWhole(t *testing.T) {
	t.Parallel()

	r := newTestRenderer(t)

	// The cap is a bound on the pathological case, not a budget every issue is
	// spent against. A normal ticket arrives intact and says nothing about
	// truncation.
	detail := ticket()
	rendered, err := r.Render(Input{Stage: work.StagePlan, Ticket: detail})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if !strings.Contains(rendered, detail.Body) {
		t.Error("an ordinary issue body did not reach the prompt whole")
	}
	if strings.Contains(rendered, "truncated") {
		t.Error("the prompt claims an ordinary issue was truncated")
	}
}

func TestTruncateCutsOnARuneBoundary(t *testing.T) {
	t.Parallel()

	// Cutting mid-rune would put invalid UTF-8 into the prompt and, in a body
	// that is mostly non-ASCII, at the exact point a reader is looking.
	got, cut := truncate(strings.Repeat("é", 100), 51)
	if !cut {
		t.Fatal("truncate did not cut text over the limit")
	}
	if !utf8.ValidString(got) {
		t.Errorf("truncate produced invalid UTF-8: %q", got)
	}
	if len(got) > 51 {
		t.Errorf("truncate kept %d bytes, want at most 51", len(got))
	}
	if whole, cut := truncate("short", 51); cut || whole != "short" {
		t.Errorf("truncate(%q, 51) = %q, %t; want it left alone", "short", whole, cut)
	}
}
