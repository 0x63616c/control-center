package github

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// Paths every test in this file addresses, spelled once.
var (
	issuesPath   = fmt.Sprintf("/repos/%s/%s/issues", testOwner, testRepo)
	issuePath    = fmt.Sprintf("%s/%d", issuesPath, testIssue)
	commentsPath = issuePath + "/comments"
	autoPath     = fmt.Sprintf("%s/labels/%s", issuePath, autoLabel)
	commentPath  = fmt.Sprintf("%s/comments/999", issuesPath)
	exchangePath = fmt.Sprintf("/app/installations/%d/access_tokens", testInstallationID)
)

// issue builds the JSON GitHub returns for one issue.
func issue(number int, title, body string, labels ...string) map[string]any {
	named := make([]any, 0, len(labels))
	for _, l := range labels {
		named = append(named, map[string]any{"name": l})
	}
	return map[string]any{"number": number, "title": title, "body": body, "labels": named}
}

// comment builds the JSON GitHub returns for one issue comment.
func comment(id int64, author, body string) map[string]any {
	return map[string]any{"id": id, "body": body, "user": map[string]any{"login": author}}
}

func TestListsTheOpenIssuesLabelledAuto(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("GET "+issuesPath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, []any{
			issue(328, "Provision the namespaces", "body one", autoLabel),
			issue(331, "Wire the seam", "body two", autoLabel),
		})
	})
	c, _ := s.client(t)

	got, err := c.ListAutoTickets(context.Background())
	if err != nil {
		t.Fatalf("ListAutoTickets returned an unexpected error: %v", err)
	}

	query := s.first(t, "GET "+issuesPath).Query
	for key, want := range map[string]string{
		"state":    "open",
		"labels":   autoLabel,
		"per_page": "100",
	} {
		if got := query.Get(key); got != want {
			t.Errorf("query %s = %q, want %q", key, got, want)
		}
	}

	want := []work.Ticket{
		{Number: 328, Title: "Provision the namespaces", Body: "body one"},
		{Number: 331, Title: "Wire the seam", Body: "body two"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d tickets, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("ticket %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestExcludesPullRequestsThatCarryTheAutoLabel(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("GET "+issuesPath, func(w http.ResponseWriter, _ *http.Request) {
		pr := issue(400, "a pull request", "", autoLabel)
		pr["pull_request"] = map[string]any{"url": "https://api.github.com/pulls/400"}
		writeJSON(w, http.StatusOK, []any{pr, issue(328, "a real ticket", "", autoLabel)})
	})
	c, _ := s.client(t)

	got, err := c.ListAutoTickets(context.Background())
	if err != nil {
		t.Fatalf("ListAutoTickets returned an unexpected error: %v", err)
	}
	if len(got) != 1 || got[0].Number != 328 {
		t.Errorf("got %+v, want only issue #328 — the issues endpoint returns pull requests too", got)
	}
}

func TestFollowsPaginationToTheLastPage(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("GET "+issuesPath, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") == "2" {
			writeJSON(w, http.StatusOK, []any{issue(331, "second page", "", autoLabel)})
			return
		}
		w.Header().Set("Link", fmt.Sprintf(`<%s%s?page=2>; rel="next"`, s.URL, issuesPath))
		writeJSON(w, http.StatusOK, []any{issue(328, "first page", "", autoLabel)})
	})
	c, _ := s.client(t)

	got, err := c.ListAutoTickets(context.Background())
	if err != nil {
		t.Fatalf("ListAutoTickets returned an unexpected error: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d tickets, want both pages: %s", len(got), s)
	}
}

func TestReturnsNothingWhenALaterPageFails(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("GET "+issuesPath, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") == "2" {
			writeError(w, http.StatusInternalServerError, "server error")
			return
		}
		w.Header().Set("Link", fmt.Sprintf(`<%s%s?page=2>; rel="next"`, s.URL, issuesPath))
		writeJSON(w, http.StatusOK, []any{issue(328, "first page", "", autoLabel)})
	})
	c, _ := s.client(t)

	got, err := c.ListAutoTickets(context.Background())
	if err == nil {
		t.Fatal("ListAutoTickets succeeded despite a failed page")
	}
	if got != nil {
		// A partial list shrinks the eligible set and reads as a quiet backlog.
		t.Errorf("got %d tickets alongside an error, want none", len(got))
	}
}

func TestReturnsNoTicketsWhenNothingIsLabelledAuto(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("GET "+issuesPath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, []any{})
	})
	c, _ := s.client(t)

	got, err := c.ListAutoTickets(context.Background())
	if err != nil {
		t.Fatalf("ListAutoTickets returned an unexpected error: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("got %d tickets, want none", len(got))
	}
}

func TestFailsRatherThanReturningATicketWithNoNumber(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("GET "+issuesPath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, []any{map[string]any{"title": "no number here"}})
	})
	c, _ := s.client(t)

	got, err := c.ListAutoTickets(context.Background())
	if err == nil {
		t.Fatal("ListAutoTickets returned a ticket with no number")
	}
	if got != nil {
		t.Errorf("got %d tickets alongside an error, want none", len(got))
	}
}

func TestPreservesIssueTextVerbatim(t *testing.T) {
	t.Parallel()

	// Attacker-controllable text: it must survive byte-identical, and it must
	// not be interpreted anywhere on the way.
	const title = "fix `$(id)` in the ${PATH} handler"
	const body = "line one\n\n```sh\nrm -rf / # $(whoami)\n```\n\"quoted\" & <tagged>"

	s, _ := newStub(t)
	s.handle("GET "+issuesPath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, []any{issue(328, title, body, autoLabel)})
	})
	c, _ := s.client(t)

	got, err := c.ListAutoTickets(context.Background())
	if err != nil {
		t.Fatalf("ListAutoTickets returned an unexpected error: %v", err)
	}
	if got[0].Title != title || got[0].Body != body {
		t.Errorf("ticket = %q / %q, want %q / %q", got[0].Title, got[0].Body, title, body)
	}
}

func TestReadsTheAutoLabelFromOneIssue(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name   string
		labels []string
		want   bool
	}{
		{name: "present", labels: []string{autoLabel}, want: true},
		{name: "absent", labels: []string{"bug"}, want: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			s, _ := newStub(t)
			s.handle("GET "+issuePath, func(w http.ResponseWriter, _ *http.Request) {
				writeJSON(w, http.StatusOK, issue(testIssue, "ticket", "body", tc.labels...))
			})
			c, _ := s.client(t)

			got, err := c.AutoLabelPresent(context.Background(), testIssue)
			if err != nil {
				t.Fatalf("AutoLabelPresent: %v", err)
			}
			if got != tc.want {
				t.Errorf("AutoLabelPresent = %t, want %t", got, tc.want)
			}
		})
	}
}

func TestPostsTheRunsStatusCommentAndReturnsItsID(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("GET "+commentsPath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, []any{})
	})
	s.handle("POST "+commentsPath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusCreated, comment(999, testBotLogin, "posted"))
	})
	c, _ := s.client(t)

	body := work.StatusMarker("run-a", work.StepPickup) + "\n### software factory — implementing"
	got, err := c.PostStatus(context.Background(), testIssue, body)
	if err != nil {
		t.Fatalf("PostStatus returned an unexpected error: %v", err)
	}
	if got != work.CommentID(999) {
		t.Errorf("PostStatus = %d, want 999", got)
	}
	sent := decodeBody(t, s.first(t, "POST "+commentsPath))
	if sent["body"] != body {
		t.Errorf("posted body = %q, want %q", sent["body"], body)
	}
	if len(sent) != 1 {
		t.Errorf("posted %v, want a body-only request", sent)
	}
}

func TestAdoptsItsOwnEarlierStatusCommentInsteadOfPostingASecondOne(t *testing.T) {
	t.Parallel()

	marker := work.StatusMarker("run-a", work.StepPickup)
	s, _ := newStub(t)
	s.handle("GET "+commentsPath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, []any{comment(999, testBotLogin, marker+"\nearlier")})
	})
	s.handle("POST "+commentsPath, func(http.ResponseWriter, *http.Request) {
		t.Error("posted a second status comment instead of adopting the first")
	})
	c, _ := s.client(t)

	got, err := c.PostStatus(context.Background(), testIssue, marker+"\nlater")
	if err != nil {
		t.Fatalf("PostStatus returned an unexpected error: %v", err)
	}
	if got != work.CommentID(999) {
		t.Errorf("PostStatus = %d, want the existing comment 999", got)
	}
}

func TestPostsANewCommentWhenOnlyAnEarlierRunsStatusCommentIsPresent(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("GET "+commentsPath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, []any{comment(111, testBotLogin, work.StatusMarker("older-run", work.StepPickup)+"\nhistory")})
	})
	s.handle("POST "+commentsPath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusCreated, comment(999, testBotLogin, "posted"))
	})
	c, _ := s.client(t)

	got, err := c.PostStatus(context.Background(), testIssue, work.StatusMarker("run-a", work.StepPickup)+"\nnew")
	if err != nil {
		t.Fatalf("PostStatus returned an unexpected error: %v", err)
	}
	if got != work.CommentID(999) {
		t.Errorf("PostStatus = %d, want a freshly posted 999 — a previous run's comment is history", got)
	}
}

func TestDoesNotAdoptAMarkerCommentWrittenBySomeoneElse(t *testing.T) {
	t.Parallel()

	marker := work.StatusMarker("run-a", work.StepPickup)
	s, _ := newStub(t)
	s.handle("GET "+commentsPath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, []any{comment(111, "some-human", marker+"\nlook what I can do")})
	})
	s.handle("POST "+commentsPath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusCreated, comment(999, testBotLogin, "posted"))
	})
	c, _ := s.client(t)

	got, err := c.PostStatus(context.Background(), testIssue, marker+"\nours")
	if err != nil {
		t.Fatalf("PostStatus returned an unexpected error: %v", err)
	}
	if got == work.CommentID(111) {
		t.Fatal("adopted a stranger's comment; the run would edit someone else's words")
	}
	if got != work.CommentID(999) {
		t.Errorf("PostStatus = %d, want a freshly posted 999", got)
	}
}

func TestPagesTheCommentListToFindItsOwnStatusComment(t *testing.T) {
	t.Parallel()

	marker := work.StatusMarker("run-a", work.StepPickup)
	s, _ := newStub(t)
	s.handle("GET "+commentsPath, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") == "2" {
			writeJSON(w, http.StatusOK, []any{comment(999, testBotLogin, marker+"\nearlier")})
			return
		}
		w.Header().Set("Link", fmt.Sprintf(`<%s%s?page=2>; rel="next"`, s.URL, commentsPath))
		writeJSON(w, http.StatusOK, []any{comment(111, "some-human", "unrelated")})
	})
	s.handle("POST "+commentsPath, func(http.ResponseWriter, *http.Request) {
		t.Error("posted a second status comment instead of paging to find the first")
	})
	c, _ := s.client(t)

	got, err := c.PostStatus(context.Background(), testIssue, marker+"\nlater")
	if err != nil {
		t.Fatalf("PostStatus returned an unexpected error: %v", err)
	}
	if got != work.CommentID(999) {
		t.Errorf("PostStatus = %d, want the comment on page 2", got)
	}
}

func TestPostsRatherThanAdoptingWhenTheBotIdentityCannotBeResolved(t *testing.T) {
	t.Parallel()

	marker := work.StatusMarker("run-a", work.StepPickup)
	s, _ := newStub(t)
	s.appGet = func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusInternalServerError, "server error")
	}
	s.handle("GET "+commentsPath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, []any{comment(111, testBotLogin, marker+"\nearlier")})
	})
	s.handle("POST "+commentsPath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusCreated, comment(999, testBotLogin, "posted"))
	})
	c, logs := s.client(t)

	got, err := c.PostStatus(context.Background(), testIssue, marker+"\nours")
	if err != nil {
		t.Fatalf("PostStatus failed because it could not learn its own name: %v", err)
	}
	if got != work.CommentID(999) {
		t.Errorf("PostStatus = %d, want a freshly posted 999 — a duplicate beats editing a stranger", got)
	}
	if !strings.Contains(logs.String(), "could not resolve this app's own identity") {
		t.Error("degrading to a duplicate comment was not logged")
	}
}

func TestResolvesTheBotIdentityOncePerClient(t *testing.T) {
	t.Parallel()

	marker := work.StatusMarker("run-a", work.StepPickup)
	s, _ := newStub(t)
	s.handle("GET "+commentsPath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, []any{})
	})
	s.handle("POST "+commentsPath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusCreated, comment(999, testBotLogin, "posted"))
	})
	c, _ := s.client(t)

	for range 2 {
		if _, err := c.PostStatus(context.Background(), testIssue, marker+"\nours"); err != nil {
			t.Fatalf("PostStatus returned an unexpected error: %v", err)
		}
	}
	if got := s.count("GET /app"); got != 1 {
		t.Errorf("read this app's identity %d times, want 1 — it never changes", got)
	}
}

func TestPostsWithoutListingWhenTheBodyCarriesNoMarker(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("GET "+commentsPath, func(http.ResponseWriter, *http.Request) {
		t.Error("listed the comments for a body that identifies no run")
	})
	s.handle("POST "+commentsPath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusCreated, comment(999, testBotLogin, "posted"))
	})
	c, _ := s.client(t)

	if _, err := c.PostStatus(context.Background(), testIssue, "no marker here"); err != nil {
		t.Fatalf("PostStatus returned an unexpected error: %v", err)
	}
}

func TestTruncatesAnOversizedStatusBody(t *testing.T) {
	t.Parallel()

	oversized := work.StatusMarker("run-a", work.StepPickup) + "\n" + strings.Repeat("x", 200_000)

	t.Run("when posting", func(t *testing.T) {
		t.Parallel()
		s, _ := newStub(t)
		s.handle("GET "+commentsPath, func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, []any{})
		})
		s.handle("POST "+commentsPath, func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusCreated, comment(999, testBotLogin, "posted"))
		})
		c, _ := s.client(t)

		if _, err := c.PostStatus(context.Background(), testIssue, oversized); err != nil {
			t.Fatalf("PostStatus returned an unexpected error: %v", err)
		}
		assertCapped(t, decodeBody(t, s.first(t, "POST "+commentsPath))["body"])
	})

	t.Run("when editing", func(t *testing.T) {
		t.Parallel()
		s, _ := newStub(t)
		s.handle("PATCH "+commentPath, func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, comment(999, testBotLogin, "edited"))
		})
		c, _ := s.client(t)

		if err := c.EditStatus(context.Background(), work.CommentID(999), oversized); err != nil {
			t.Fatalf("EditStatus returned an unexpected error: %v", err)
		}
		assertCapped(t, decodeBody(t, s.first(t, "PATCH "+commentPath))["body"])
	})
}

func TestTruncatesOnARuneBoundary(t *testing.T) {
	t.Parallel()

	// Three-byte runes, sized so the cap lands mid-rune.
	oversized := strings.Repeat("→", maxCommentBytes)

	s, _ := newStub(t)
	s.handle("PATCH "+commentPath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, comment(999, testBotLogin, "edited"))
	})
	c, _ := s.client(t)

	if err := c.EditStatus(context.Background(), work.CommentID(999), oversized); err != nil {
		t.Fatalf("EditStatus returned an unexpected error: %v", err)
	}
	sent, _ := decodeBody(t, s.first(t, "PATCH "+commentPath))["body"].(string)
	if !utf8.ValidString(sent) {
		t.Error("the truncated body is not valid utf-8; the cap cut a rune in half")
	}
	assertCapped(t, sent)
}

// assertCapped checks a written body was bounded and says so.
func assertCapped(t *testing.T, sent any) {
	t.Helper()
	body, ok := sent.(string)
	if !ok {
		t.Fatalf("body = %v, want a string", sent)
	}
	if len(body) > maxCommentBytes {
		t.Errorf("body is %d bytes, want at most %d", len(body), maxCommentBytes)
	}
	if !strings.HasSuffix(body, truncationNotice) {
		t.Error("the truncated body does not say it was truncated")
	}
}

func TestRewritesTheStatusCommentInPlace(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("PATCH "+commentPath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, comment(999, testBotLogin, "edited"))
	})
	c, _ := s.client(t)

	if err := c.EditStatus(context.Background(), work.CommentID(999), "revised"); err != nil {
		t.Fatalf("EditStatus returned an unexpected error: %v", err)
	}
	sent := decodeBody(t, s.first(t, "PATCH "+commentPath))
	if sent["body"] != "revised" || len(sent) != 1 {
		t.Errorf("patched %v, want a body-only request", sent)
	}
}

func TestReportsADeletedStatusCommentAsPermanent(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("PATCH "+commentPath, func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "Not Found")
	})
	c, _ := s.client(t)

	err := c.EditStatus(context.Background(), work.CommentID(999), "revised")
	assertPermanent(t, err, ErrNotFound)
	if !strings.Contains(err.Error(), "999") {
		t.Errorf("error %q does not name the comment it could not rewrite", err)
	}
}

func TestReportsADeletedIssueAsPermanent(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("POST "+commentsPath, func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "Not Found")
	})
	c, _ := s.client(t)

	_, err := c.PostStatus(context.Background(), testIssue, "no marker")
	assertPermanent(t, err, ErrNotFound)
}

func TestRemovesTheAutoLabel(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("DELETE "+autoPath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, []any{})
	})
	s.handle("GET "+issuePath, func(http.ResponseWriter, *http.Request) {
		t.Error("re-read the issue after a successful label removal")
	})
	c, _ := s.client(t)

	if err := c.ClearAutoLabel(context.Background(), testIssue); err != nil {
		t.Fatalf("ClearAutoLabel returned an unexpected error: %v", err)
	}
	if got := s.first(t, "DELETE "+autoPath).Path; got != autoPath {
		t.Errorf("removed %q, want exactly the auto label", got)
	}
}

func TestTreatsAnAlreadyAbsentAutoLabelAsSuccess(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("DELETE "+autoPath, func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "Label does not exist")
	})
	s.handle("GET "+issuePath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, issue(testIssue, "a ticket", "", "area/infra"))
	})
	c, logs := s.client(t)

	if err := c.ClearAutoLabel(context.Background(), testIssue); err != nil {
		t.Fatalf("ClearAutoLabel failed on a label that is already gone: %v", err)
	}
	if !strings.Contains(logs.String(), "already absent") {
		t.Error("the benign 404 was not logged")
	}
}

func TestReportsA404ThatLeftTheAutoLabelInPlaceAsAPermanentAuthFailure(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("DELETE "+autoPath, func(w http.ResponseWriter, _ *http.Request) {
		// GitHub answers 404 rather than 403 for a resource in a private
		// repository that a token cannot reach.
		writeError(w, http.StatusNotFound, "Not Found")
	})
	s.handle("GET "+issuePath, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, issue(testIssue, "a ticket", "", autoLabel))
	})
	c, logs := s.client(t)

	err := c.ClearAutoLabel(context.Background(), testIssue)
	assertPermanent(t, err, ErrAuth)
	if !strings.Contains(err.Error(), "still on issue") {
		t.Errorf("error %q does not say the label survived", err)
	}
	if !strings.Contains(err.Error(), "issues:write") {
		t.Errorf("error %q does not name the likely cause", err)
	}
	if !strings.Contains(logs.String(), `"level":"ERROR"`) {
		t.Error("a ticket that will now re-run forever was not logged at ERROR")
	}
}

func TestReportsAnUnreachableIssueAsPermanent(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("DELETE "+autoPath, func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "Not Found")
	})
	s.handle("GET "+issuePath, func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "Not Found")
	})
	c, _ := s.client(t)

	err := c.ClearAutoLabel(context.Background(), testIssue)
	assertPermanent(t, err, ErrNotFound)
	for _, want := range []string{"deleted", "can no longer see it"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q; both possibilities matter to whoever reads it", err, want)
		}
	}
}

func TestRetriesWhenTheVerificationReadItselfFailsTransiently(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("DELETE "+autoPath, func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "Not Found")
	})
	s.handle("GET "+issuePath, func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusInternalServerError, "server error")
	})
	c, _ := s.client(t)

	assertRetryable(t, c.ClearAutoLabel(context.Background(), testIssue))
}

func TestMintsARepositoryScopedTokenCarryingEveryPermissionTheSandboxNeeds(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	c, _ := s.client(t)

	cred, err := c.InstallationToken(context.Background())
	if err != nil {
		t.Fatalf("InstallationToken returned an unexpected error: %v", err)
	}
	if cred.Token.Reveal() != "installation-token-1" {
		t.Errorf("credential = %q, want the exchanged token", cred.Token.Reveal())
	}
	if cred.Login != testBotLogin {
		t.Errorf("credential login = %q, want %q", cred.Login, testBotLogin)
	}
	if cred.AccountID != testBotAccountID {
		t.Errorf("credential account ID = %d, want %d", cred.AccountID, testBotAccountID)
	}
	if auth := s.first(t, "GET /app").Auth; !strings.HasPrefix(auth, "Bearer eyJ") {
		t.Errorf("GET /app Authorization = %q, want the app jwt", auth)
	}
	if auth := s.first(t, "GET /users/"+testBotLogin).Auth; auth != "" {
		t.Errorf("GET /users/%s Authorization = %q, want no authentication", testBotLogin, auth)
	}

	sent := decodeBody(t, s.first(t, "POST "+exchangePath))
	repos, _ := sent["repositories"].([]any)
	if len(repos) != 1 || repos[0] != testRepo {
		t.Errorf("repositories = %v, want exactly [%s]", sent["repositories"], testRepo)
	}

	granted, _ := sent["permissions"].(map[string]any)
	want := map[string]any{
		"contents":      "write",
		"workflows":     "write",
		"pull_requests": "write",
		"metadata":      "read",
	}
	for name, level := range want {
		if granted[name] != level {
			// workflows:write in particular: without it a push touching
			// .github/workflows is rejected at the git layer, with an error
			// that never reaches this client's taxonomy.
			t.Errorf("permission %s = %v, want %v", name, granted[name], level)
		}
	}
	if len(granted) != len(want) {
		t.Errorf("permissions = %v, want exactly %v", granted, want)
	}
}

func TestCachesBotAttributionButMintsAFreshSandboxToken(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	c, _ := s.client(t)

	for range 2 {
		if _, err := c.InstallationToken(context.Background()); err != nil {
			t.Fatalf("InstallationToken returned an unexpected error: %v", err)
		}
	}
	if got := s.count("GET /app"); got != 1 {
		t.Errorf("GET /app count = %d, want 1", got)
	}
	if got := s.count("GET /users/" + testBotLogin); got != 1 {
		t.Errorf("GET /users/%s count = %d, want 1", testBotLogin, got)
	}
	if got := s.count("POST " + exchangePath); got != 2 {
		t.Errorf("sandbox token exchanges = %d, want 2", got)
	}
}

func TestDoesNotMintASandboxTokenWhenBotProfileLookupFails(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.userGet = func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusInternalServerError, "server error")
	}
	c, _ := s.client(t)

	if _, err := c.InstallationToken(context.Background()); err == nil {
		t.Fatal("InstallationToken succeeded despite a failed bot profile lookup")
	}
	if got := s.count("POST " + exchangePath); got != 0 {
		t.Errorf("sandbox token exchanges = %d, want 0 after profile lookup failure", got)
	}
	if login, err := c.botLogin(context.Background()); err != nil || login != testBotLogin {
		t.Errorf("botLogin = %q, %v; want cached login %q and no error", login, err, testBotLogin)
	}
}

func TestRejectsMalformedBotProfilesBeforeMintingASandboxToken(t *testing.T) {
	t.Parallel()

	cases := map[string]map[string]any{
		"zero account id":  {"id": 0, "login": testBotLogin},
		"empty login":      {"id": testBotAccountID, "login": ""},
		"mismatched login": {"id": testBotAccountID, "login": "some-other-bot[bot]"},
	}
	for name, profile := range cases {
		t.Run(name, func(t *testing.T) {
			s, _ := newStub(t)
			s.userGet = func(w http.ResponseWriter, _ *http.Request) {
				writeJSON(w, http.StatusOK, profile)
			}
			c, _ := s.client(t)

			if _, err := c.InstallationToken(context.Background()); err == nil {
				t.Fatal("InstallationToken succeeded despite a malformed bot profile")
			}
			if got := s.count("POST " + exchangePath); got != 0 {
				t.Errorf("sandbox token exchanges = %d, want 0 after malformed profile", got)
			}
		})
	}
}

func TestDoesNotGrantTheSandboxIssuesWrite(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	c, _ := s.client(t)

	if _, err := c.InstallationToken(context.Background()); err != nil {
		t.Fatalf("InstallationToken returned an unexpected error: %v", err)
	}

	granted, _ := decodeBody(t, s.first(t, "POST "+exchangePath))["permissions"].(map[string]any)
	for _, name := range []string{"issues", "actions", "checks", "statuses"} {
		if _, present := granted[name]; present {
			t.Errorf("the sandbox token requests %s; the worker writes to the issue, not the sandbox", name)
		}
	}
}

func TestReportsAnUngrantedPermissionAsAnAuthFailureNamingTheMissingGrant(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.exchange = func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusUnprocessableEntity, "The permissions requested are not granted to this installation.")
	}
	c, _ := s.client(t)

	_, err := c.InstallationToken(context.Background())
	assertPermanent(t, err, ErrAuth)
	if !strings.Contains(err.Error(), "pending permission request") {
		t.Errorf("error %q does not point at approving the pending grant", err)
	}
}

func TestDoesNotHandTheSandboxTheCachedToken(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	listIssues(s)
	c, _ := s.client(t)

	if _, err := c.ListAutoTickets(context.Background()); err != nil {
		t.Fatalf("ListAutoTickets returned an unexpected error: %v", err)
	}
	cred, err := c.InstallationToken(context.Background())
	if err != nil {
		t.Fatalf("InstallationToken returned an unexpected error: %v", err)
	}

	if got := s.count("POST " + exchangePath); got != 2 {
		t.Errorf("exchanged %d times, want 2 — the sandbox gets a fresh full-hour token", got)
	}
	if cred.Token.Reveal() != "installation-token-2" {
		t.Errorf("the sandbox got %q, want the freshly minted token", cred.Token.Reveal())
	}
}

func TestReturnsACredentialThatRedactsItself(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	c, _ := s.client(t)

	cred, err := c.InstallationToken(context.Background())
	if err != nil {
		t.Fatalf("InstallationToken returned an unexpected error: %v", err)
	}
	if got := fmt.Sprintf("%v", cred); got != "[redacted]" {
		t.Errorf("a stray %%v printed %q", got)
	}
}
