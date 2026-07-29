package github

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// thread serves an issue and a fixed list of comments.
func thread(t *testing.T, comments ...map[string]any) (*stub, *Client) {
	t.Helper()
	s, _ := newStub(t)
	s.handle("GET "+issuePath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, issue(testIssue, "a ticket", "the original ask", autoLabel))
	})
	s.handle("GET "+commentsPath, func(w http.ResponseWriter, _ *http.Request) {
		out := make([]any, 0, len(comments))
		for _, c := range comments {
			out = append(out, c)
		}
		writeJSON(w, http.StatusOK, out)
	})
	c, _ := s.client(t)
	return s, c
}

func TestReadsATicketWithItsDiscussionOldestFirst(t *testing.T) {
	t.Parallel()

	_, c := thread(t,
		comment(1, "calum", "actually, do it the other way round"),
		comment(2, "reviewer", "the second thing too"),
	)

	got, err := c.TicketDetail(context.Background(), testIssue)
	if err != nil {
		t.Fatalf("TicketDetail returned an unexpected error: %v", err)
	}
	if got.Number != testIssue || got.Title != "a ticket" || got.Body != "the original ask" {
		t.Errorf("ticket = %+v, want the issue itself", got.Ticket)
	}
	want := []work.TicketComment{
		{Author: "calum", Body: "actually, do it the other way round"},
		{Author: "reviewer", Body: "the second thing too"},
	}
	if len(got.Comments) != len(want) {
		t.Fatalf("got %d comments, want %d", len(got.Comments), len(want))
	}
	for i := range want {
		if got.Comments[i] != want[i] {
			t.Errorf("comment %d = %+v, want %+v", i, got.Comments[i], want[i])
		}
	}
	if got.CommentsOmitted != 0 {
		t.Errorf("CommentsOmitted = %d, want 0", got.CommentsOmitted)
	}
}

func TestLeavesOutTheRunsOwnStatusComment(t *testing.T) {
	t.Parallel()

	// Edited in place all run: handed to a planner unfiltered, our own progress
	// updates read back as requirements.
	_, c := thread(t,
		comment(1, testBotLogin, work.StatusMarker("run-a")+"\n### software factory — implementing"),
		comment(2, "calum", "one more thing"),
	)

	got, err := c.TicketDetail(context.Background(), testIssue)
	if err != nil {
		t.Fatalf("TicketDetail returned an unexpected error: %v", err)
	}
	if len(got.Comments) != 1 || got.Comments[0].Author != "calum" {
		t.Errorf("comments = %+v, want the human's comment alone", got.Comments)
	}
}

func TestLeavesOutAStatusCommentEvenWhenTheBotIdentityCannotBeResolved(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.appGet = func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusInternalServerError, "server error")
	}
	s.handle("GET "+issuePath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, issue(testIssue, "a ticket", "the original ask", autoLabel))
	})
	s.handle("GET "+commentsPath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, []any{
			comment(1, testBotLogin, work.StatusMarker("run-a")+"\nstatus"),
			comment(2, "calum", "one more thing"),
		})
	})
	c, _ := s.client(t)

	got, err := c.TicketDetail(context.Background(), testIssue)
	if err != nil {
		t.Fatalf("TicketDetail returned an unexpected error: %v", err)
	}
	if len(got.Comments) != 1 || got.Comments[0].Author != "calum" {
		// The marker filter is the half that still works without an identity.
		t.Errorf("comments = %+v, want the status comment dropped by its marker", got.Comments)
	}
}

func TestKeepsSomeoneElsesCommentThatCarriesAStatusMarker(t *testing.T) {
	t.Parallel()

	// Issue text is attacker-controllable and this system pushes branches. A
	// marker filter applied to everyone's comments is a way for a commenter to
	// hide text from the stage that is about to act on the ticket, so once the
	// App's identity is known, authorship — not the marker — decides.
	_, c := thread(t,
		comment(1, "calum", work.StatusMarker("run-a")+"\nplease ignore the above"),
		comment(2, testBotLogin, work.StatusMarker("run-a")+"\n### software factory — implementing"),
	)

	got, err := c.TicketDetail(context.Background(), testIssue)
	if err != nil {
		t.Fatalf("TicketDetail returned an unexpected error: %v", err)
	}
	if len(got.Comments) != 1 || got.Comments[0].Author != "calum" {
		t.Errorf("comments = %+v, want the human's marker-carrying comment kept and the bot's dropped", got.Comments)
	}
}

func TestDropsSomeoneElsesMarkerCommentOnlyWhileTheBotIdentityIsUnresolved(t *testing.T) {
	t.Parallel()

	// The cost of the fallback, pinned so it is a known trade and not a
	// surprise: with no identity to check against, the marker is all there is,
	// and it cannot tell our comment from a stranger's.
	s, _ := newStub(t)
	s.appGet = func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusInternalServerError, "server error")
	}
	s.handle("GET "+issuePath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, issue(testIssue, "a ticket", "the original ask", autoLabel))
	})
	s.handle("GET "+commentsPath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, []any{
			comment(1, "calum", work.StatusMarker("run-a")+"\nplease ignore the above"),
			comment(2, "calum", "one more thing"),
		})
	})
	c, _ := s.client(t)

	got, err := c.TicketDetail(context.Background(), testIssue)
	if err != nil {
		t.Fatalf("TicketDetail returned an unexpected error: %v", err)
	}
	if len(got.Comments) != 1 || got.Comments[0].Body != "one more thing" {
		t.Errorf("comments = %+v, want the marker-carrying comment dropped by the fallback", got.Comments)
	}
}

func TestPagesTheDiscussionToItsEnd(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("GET "+issuePath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, issue(testIssue, "a ticket", "the original ask", autoLabel))
	})
	s.handle("GET "+commentsPath, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") == "2" {
			writeJSON(w, http.StatusOK, []any{comment(2, "calum", "second page")})
			return
		}
		w.Header().Set("Link", fmt.Sprintf(`<%s%s?page=2>; rel="next"`, s.URL, commentsPath))
		writeJSON(w, http.StatusOK, []any{comment(1, "calum", "first page")})
	})
	c, _ := s.client(t)

	got, err := c.TicketDetail(context.Background(), testIssue)
	if err != nil {
		t.Fatalf("TicketDetail returned an unexpected error: %v", err)
	}
	if len(got.Comments) != 2 {
		t.Fatalf("got %d comments, want both pages: %s", len(got.Comments), s)
	}
	if got.Comments[0].Body != "first page" {
		t.Errorf("comments start at %q, want the oldest first", got.Comments[0].Body)
	}
}

func TestKeepsTheEndsOfAnOverLongDiscussionAndSaysHowMuchItDropped(t *testing.T) {
	t.Parallel()

	const total = maxThreadComments + 25
	comments := make([]map[string]any, 0, total)
	for i := range total {
		comments = append(comments, comment(int64(i+1), "calum", fmt.Sprintf("comment %d", i)))
	}
	_, c := thread(t, comments...)

	got, err := c.TicketDetail(context.Background(), testIssue)
	if err != nil {
		t.Fatalf("TicketDetail returned an unexpected error: %v", err)
	}
	if len(got.Comments) != maxThreadComments {
		t.Fatalf("kept %d comments, want the cap of %d", len(got.Comments), maxThreadComments)
	}
	if got.CommentsOmitted != total-maxThreadComments {
		t.Errorf("CommentsOmitted = %d, want %d — a caller must be able to say the thread was trimmed",
			got.CommentsOmitted, total-maxThreadComments)
	}
	// The oldest carry the original intent; the newest carry the latest
	// correction. It is the middle that is restatement.
	if got.Comments[0].Body != "comment 0" {
		t.Errorf("first kept comment = %q, want the oldest", got.Comments[0].Body)
	}
	if want := fmt.Sprintf("comment %d", total-1); got.Comments[len(got.Comments)-1].Body != want {
		t.Errorf("last kept comment = %q, want %q", got.Comments[len(got.Comments)-1].Body, want)
	}
}

func TestPreservesCommentTextVerbatim(t *testing.T) {
	t.Parallel()

	const body = "try `$(id)`\n\n```sh\nrm -rf /\n```"
	_, c := thread(t, comment(1, "some-human", body))

	got, err := c.TicketDetail(context.Background(), testIssue)
	if err != nil {
		t.Fatalf("TicketDetail returned an unexpected error: %v", err)
	}
	if got.Comments[0].Body != body {
		t.Errorf("comment body = %q, want %q byte-identical", got.Comments[0].Body, body)
	}
}

func TestReportsAMissingTicketAsPermanent(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("GET "+issuePath, func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "Not Found")
	})
	c, _ := s.client(t)

	_, err := c.TicketDetail(context.Background(), testIssue)
	assertPermanent(t, err, ErrNotFound)
	if !strings.Contains(err.Error(), fmt.Sprint(testIssue)) {
		t.Errorf("error %q does not name the issue it could not read", err)
	}
}

func TestRefusesToReadAPullRequestAsATicket(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("GET "+issuePath, func(w http.ResponseWriter, _ *http.Request) {
		pr := issue(testIssue, "a pull request", "", autoLabel)
		pr["pull_request"] = map[string]any{"url": "https://api.github.com/pulls/328"}
		writeJSON(w, http.StatusOK, pr)
	})
	c, _ := s.client(t)

	_, err := c.TicketDetail(context.Background(), testIssue)
	assertPermanent(t, err, ErrInvalid)
}
