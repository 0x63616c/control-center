// Package prompts renders one pipeline stage's prompt: what the stage is told
// to do, the issue it is told to do it for, and the documents earlier stages
// handed forward.
//
// It is the whole of what this system says to a model. The stage runner takes a
// rendered string and never assembles one, so issue text — which anyone who can
// file or comment on an issue chooses — reaches a prompt through exactly one
// function, wrapped in exactly one fence. That is why the templates are
// markdown files here rather than strings spread across the workflows that use
// them: changing what a plan should contain is an edit to prose, reviewed as
// prose, with no struct, schema or golden file to regenerate.
//
// The envelope a stage answers in lives here too, for the same reason. Schema
// and Document are the two ends of one fact — `{"document": "<markdown>"}` —
// and splitting them would leave the writer of the schema and the reader of the
// result free to disagree.
package prompts

import (
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// Renderer renders stage prompts.
//
// It holds the entropy source and nothing else: no ticket, no run, no state
// between calls. One renderer serves every run the worker has in flight, and
// two concurrent Renders cannot see each other's nonce.
type Renderer struct {
	entropy io.Reader
}

// New builds a renderer on a source of randomness.
//
// The source is injected rather than reached for, because it is an external
// edge like any other: a test that could not choose the nonce could not plant
// it in an issue body and prove it gets stripped. cmd/ passes crypto/rand.
func New(entropy io.Reader) (*Renderer, error) {
	if entropy == nil {
		return nil, fmt.Errorf("a prompt renderer needs an entropy source: the fence nonce is drawn from it")
	}
	return &Renderer{entropy: entropy}, nil
}

// Input is everything one stage's prompt interpolates.
type Input struct {
	// Stage is the stage being rendered for.
	Stage work.Stage

	// Ticket is the issue and its thread, as the issue's authors wrote them.
	// Every field of it is attacker-controlled text and is rendered inside the
	// fence.
	Ticket work.TicketDetail

	// Prior holds each completed stage's document, keyed by the stage that
	// produced it. A run may pass everything it has: a stage is shown only the
	// documents its own prompt asks for, and nothing is required of a stage
	// that has not run yet.
	Prior map[work.Stage]string
}

// Render assembles the stage's whole prompt.
//
// The result is one string, written into the sandbox as a file. It is never an
// argument to anything: the argv-only guarantee in AGENTS.md exists because
// this string contains text an issue author chose.
//
// It fails rather than degrade. A prompt with a placeholder still in it, a
// missing input document, or a nonce that reached the model outside the fence
// are each a prompt that would produce confidently wrong work, and a stage that
// does not start is cheaper than a stage that starts wrong.
func (r *Renderer) Render(in Input) (string, error) {
	template, err := in.template()
	if err != nil {
		return "", err
	}
	values, err := in.staticValues()
	if err != nil {
		return "", err
	}

	nonce, err := mintNonce(r.entropy)
	if err != nil {
		return "", fmt.Errorf("rendering the %s prompt for ticket #%d: %w", in.Stage, in.Ticket.Number, err)
	}
	values["fence_nonce"] = nonce
	for name, value := range values {
		if name == "fence_nonce" {
			continue
		}
		values[name] = strip(value, nonce)
	}

	rendered, err := interpolate(template, values)
	if err != nil {
		return "", fmt.Errorf("rendering the %s prompt for ticket #%d: %w", in.Stage, in.Ticket.Number, err)
	}
	if err := checkFence(rendered, nonce); err != nil {
		return "", fmt.Errorf("rendering the %s prompt for ticket #%d: %w", in.Stage, in.Ticket.Number, err)
	}
	return rendered, nil
}

// template is the base instructions followed by this stage's own.
//
// The order is the point. The fence closes at the end of the base, so the
// stage's real task is the last thing in the prompt and untrusted text never
// has the last word.
func (in Input) template() (string, error) {
	stageFile, err := stageTemplate(in.Stage)
	if err != nil {
		return "", err
	}
	base, err := templates.ReadFile(baseTemplate)
	if err != nil {
		return "", fmt.Errorf("reading %s: %w", baseTemplate, err)
	}
	stage, err := templates.ReadFile(stageFile)
	if err != nil {
		return "", fmt.Errorf("reading %s: %w", stageFile, err)
	}
	return string(base) + "\n" + string(stage), nil
}

// staticValues is every interpolated value except the nonce, with the input
// validated on the way: a value that cannot be rendered honestly is an error
// here rather than a gap in the prompt.
func (in Input) staticValues() (map[string]string, error) {
	if in.Ticket.Number <= 0 {
		return nil, fmt.Errorf("ticket number %d is not an issue number: the prompt names the issue it is for", in.Ticket.Number)
	}
	if strings.TrimSpace(in.Ticket.Title) == "" {
		return nil, fmt.Errorf("ticket #%d has no title: every GitHub issue has one, so this detail was not fetched", in.Ticket.Number)
	}

	values := map[string]string{
		"ticket_number":   strconv.Itoa(in.Ticket.Number),
		"ticket_title":    in.Ticket.Title,
		"ticket_body":     body(in.Ticket),
		"ticket_comments": comments(in.Ticket),
	}

	for _, produced := range reads(in.Stage) {
		document := in.Prior[produced]
		if strings.TrimSpace(document) == "" {
			return nil, fmt.Errorf("the %s stage reads the %s stage's document, and there is none: the run cannot skip a stage", in.Stage, produced)
		}
		name, err := documentVar(produced)
		if err != nil {
			return nil, err
		}
		values[name] = document
	}
	return values, nil
}

// body is the issue's description, or a statement that it has none.
//
// An empty region in a prompt reads to a model as something it failed to
// receive. Saying the issue was filed without a description is the difference
// between a planner treating that as a fact about the ticket and a planner
// treating it as its own missing context.
func body(detail work.TicketDetail) string {
	if strings.TrimSpace(detail.Body) == "" {
		return "(This issue was filed with no description.)"
	}
	return detail.Body
}

// comments renders the issue's thread, oldest first.
//
// The thread is carried because a brain-dump issue's actual clarification
// usually arrives in it. The run's own status comment is not here — GitHub's
// seam filters it before this — so a planner is never handed our progress
// updates as requirements.
func comments(detail work.TicketDetail) string {
	if len(detail.Comments) == 0 && detail.CommentsOmitted == 0 {
		return "(This issue has no comments.)"
	}

	var out strings.Builder
	out.WriteString("Comments on the issue, oldest first:\n")
	if detail.CommentsOmitted > 0 {
		// A model that knows the thread was trimmed can say its plan rests on
		// part of it. A model that does not, cannot.
		out.WriteString(fmt.Sprintf("\n(%d comments from the middle of this thread are not shown.)\n", detail.CommentsOmitted))
	}
	for _, comment := range detail.Comments {
		out.WriteString(fmt.Sprintf("\n@%s wrote:\n\n%s\n", comment.Author, comment.Body))
	}
	return out.String()
}
