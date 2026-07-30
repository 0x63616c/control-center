// Package github is this service's whole view of the issue tracker, and the
// only place go-github's types exist. It holds the GitHub App identity: it
// signs the App JWT, exchanges it for installation tokens, and keeps one for
// its own calls while minting separate, narrower, always-fresh ones for
// sandboxes to push with.
package github

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/config"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/golang-jwt/jwt/v5"
	gh "github.com/google/go-github/v78/github"
)

// autoLabel is the one label this system touches. Nothing parameterises it:
// a general removeLabel would be an invitation to touch others.
const autoLabel = "auto"

// perPage is GitHub's maximum page size. Every listing here uses it, because
// the cost of a listing is requests, not rows.
const perPage = 100

// Defaults a caller may override.
const (
	// defaultRefreshSkew is how long before expiry an installation token counts
	// as spent. See appAuth.refreshSkew for why it is minutes, not seconds.
	defaultRefreshSkew = 5 * time.Minute

	// defaultTimeout bounds one request. Without it a wedged GitHub hangs an
	// activity until its Temporal timeout instead of failing in seconds.
	defaultTimeout = 30 * time.Second
)

// How much comment body survives a write, and how a trimmed thread is bounded.
const (
	// maxCommentBytes is a defensive cap below GitHub's own limit on a comment
	// body. The renderer bounds its free text at source; this exists so that
	// losing a status tail can never fail an otherwise healthy ticket.
	maxCommentBytes = 60_000

	// truncationNotice tells a reader the body below is not all of it.
	truncationNotice = "\n\n_…status truncated…_"

	// maxThreadComments is how many comments of a ticket's discussion
	// TicketDetail carries. The thread lands in a prompt, and a prompt is
	// finite; forty is enough to hold a long argument whole and small enough
	// that the longest thread in this repo's history still leaves room for the
	// code the stage is meant to be reading.
	maxThreadComments = 40

	// threadHeadComments is how many of those come from the start. The oldest
	// comments carry the original intent and the newest carry the latest
	// correction; it is the middle of a long thread that is restatement.
	threadHeadComments = maxThreadComments / 2
)

// Client talks to one repository as the www-software-factory-bot GitHub App.
//
// It is safe for concurrent use: the dispatcher polls for tickets while
// in-flight WorkTicket workflows post status, and they share one installation
// token rather than each refreshing their own.
type Client struct {
	owner string
	repo  string
	api   *gh.Client
	auth  *appAuth
	log   *slog.Logger

	// graphqlURL is where the pull request draft-state mutations post:
	// GitHub's production endpoint, or a test stub's when withBaseURL
	// redirected the REST plane too. See graphql.go.
	graphqlURL string

	// defaultBranchCache holds the repository's default branch once resolved
	// — see defaultBranch. It never changes without a deploy-time repository
	// setting change, so it is cached for the client's whole lifetime rather
	// than re-read before every pull request.
	defaultBranchMu    sync.Mutex
	defaultBranchCache string
}

// options is the optional half of construction. It is unexported: growth goes
// down into this struct, never out into the constructor's signature.
type options struct {
	httpClient  *http.Client
	baseURL     string
	refreshSkew time.Duration
}

// Option configures optional behaviour.
type Option func(*options)

// WithHTTPClient replaces the HTTP client both auth planes are built from. The
// composition root uses it to set a request timeout or a shared transport.
func WithHTTPClient(c *http.Client) Option {
	return func(o *options) { o.httpClient = c }
}

// withBaseURL aims the client at another GitHub, which in practice means a test
// server. Unexported because its only callers are the tests in this package.
func withBaseURL(raw string) Option {
	return func(o *options) { o.baseURL = raw }
}

// New builds a client and fails if it cannot.
//
// The private key is parsed here rather than on first use: a wrong or truncated
// PEM is a config error, and a config error belongs at startup with a clear
// message, not inside an activity retry an hour later where it reads as a
// GitHub outage.
func New(cfg config.GitHub, clk clock.Clock, log *slog.Logger, opts ...Option) (*Client, error) {
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("configuring the github client: %w", err)
	}

	o := options{
		httpClient:  &http.Client{Timeout: defaultTimeout},
		refreshSkew: defaultRefreshSkew,
	}
	for _, opt := range opts {
		opt(&o)
	}

	key, err := jwt.ParseRSAPrivateKeyFromPEM(cfg.PrivateKeyPEM)
	if err != nil {
		return nil, fmt.Errorf("parsing the app's private key (GITHUB_APP_PRIVATE_KEY_PEM_FILE): %w", err)
	}

	base := o.httpClient.Transport
	if base == nil {
		base = http.DefaultTransport
	}

	auth := &appAuth{
		appID:          cfg.AppID,
		installationID: cfg.InstallationID,
		key:            key,
		clk:            clk,
		log:            log,
		refreshSkew:    o.refreshSkew,
	}

	// Two clients from one injected base. They share a timeout and a transport
	// but never a RoundTripper: see appAuth.exchange for what happens if they
	// do.
	auth.exchange, err = newGitHubClient(&http.Client{Transport: base, Timeout: o.httpClient.Timeout}, o.baseURL)
	if err != nil {
		return nil, err
	}
	api, err := newGitHubClient(&http.Client{
		Transport: &installationTransport{base: base, auth: auth},
		Timeout:   o.httpClient.Timeout,
	}, o.baseURL)
	if err != nil {
		return nil, err
	}

	// GraphQL and REST are one API authenticated one way; when a test points
	// the REST plane at a stub via withBaseURL, the GraphQL plane follows it
	// to the same stub rather than reaching real GitHub.
	graphqlURL := "https://api.github.com/graphql"
	if o.baseURL != "" {
		graphqlURL = strings.TrimSuffix(o.baseURL, "/") + "/graphql"
	}

	return &Client{owner: cfg.Owner, repo: cfg.Repo, api: api, auth: auth, log: log, graphqlURL: graphqlURL}, nil
}

// newGitHubClient builds an SDK client, optionally aimed elsewhere. go-github
// requires a trailing slash on BaseURL and misroutes silently without one, so
// the slash is added here rather than trusted to every caller.
func newGitHubClient(hc *http.Client, baseURL string) (*gh.Client, error) {
	client := gh.NewClient(hc)
	if baseURL == "" {
		return client, nil
	}
	parsed, err := url.Parse(strings.TrimSuffix(baseURL, "/") + "/")
	if err != nil {
		return nil, fmt.Errorf("parsing the github base url %q: %w", baseURL, err)
	}
	client.BaseURL = parsed
	return client, nil
}

// ListAutoTickets returns the open issues labelled `auto`, oldest first.
//
// All or nothing: a failure on any page returns no tickets at all. A partial
// list would silently shrink the eligible set and read as a quiet backlog
// rather than as an outage.
func (c *Client) ListAutoTickets(ctx context.Context) ([]work.Ticket, error) {
	const op = "listing the open issues labelled auto"

	opts := &gh.IssueListByRepoOptions{
		State:       "open",
		Labels:      []string{autoLabel},
		Sort:        "created",
		Direction:   "asc",
		ListOptions: gh.ListOptions{PerPage: perPage},
	}

	var tickets []work.Ticket
	for {
		issues, resp, err := c.api.Issues.ListByRepo(ctx, c.owner, c.repo, opts)
		if err != nil {
			return nil, classify(ctx, op, err)
		}
		for _, issue := range issues {
			// The issues endpoint returns pull requests too, and a PR carrying
			// `auto` would be fed to the pipeline as a ticket.
			if issue.IsPullRequest() {
				continue
			}
			if issue.GetNumber() == 0 {
				return nil, fmt.Errorf("%s: github returned an issue with no number", op)
			}
			tickets = append(tickets, work.Ticket{
				Number: issue.GetNumber(),
				Title:  issue.GetTitle(),
				Body:   issue.GetBody(),
			})
		}
		if resp.NextPage == 0 {
			return tickets, nil
		}
		opts.ListOptions.Page = resp.NextPage
	}
}

// PullRequestForBranch returns the open pull request whose head is branch, if
// there is one.
//
// This is how a run learns what already exists on its own branch. It is asked
// of GitHub rather than read out of a stage's own report because that report
// is model output derived from issue text an attacker chose, and a URL taken
// from it is a phishing vector that renders as an autolink (#371). The branch
// is one the worker named from a ticket number and a Temporal RunID, so
// nothing an issue author writes can steer which branch is queried or which
// URL comes back.
//
// Not found is not an error: under the pipeline rewrite (#435), PR ownership
// is workflow code — OpenOrUpdatePullRequest creates on Found: false and edits
// on Found: true, so absence here just picks which of those two happens next.
//
// The URL returned is HTMLURL — the page a human opens — not the API URL.
func (c *Client) PullRequestForBranch(ctx context.Context, branch string) (work.PullRequest, bool, error) {
	op := fmt.Sprintf("looking for an open pull request on %s", branch)

	// Head must be qualified by owner, or GitHub matches branches of the same
	// name in every fork and can answer with someone else's pull request.
	opts := &gh.PullRequestListOptions{
		State:       "open",
		Head:        c.owner + ":" + branch,
		ListOptions: gh.ListOptions{PerPage: perPage},
	}

	prs, _, err := c.api.PullRequests.List(ctx, c.owner, c.repo, opts)
	if err != nil {
		return work.PullRequest{}, false, classify(ctx, op, err)
	}
	if len(prs) == 0 {
		return work.PullRequest{}, false, nil
	}

	// One branch, one open pull request — GitHub does not allow two from the
	// same head. Taking the first is not a guess.
	pr := prs[0]
	if pr.GetNumber() == 0 || pr.GetHTMLURL() == "" || pr.GetNodeID() == "" {
		return work.PullRequest{}, false, fmt.Errorf("%s: github returned a pull request with no number, url or node id", op)
	}

	c.log.Info("found the run's pull request", "branch", branch, "pull_request", pr.GetNumber())
	return work.PullRequest{
		Number: pr.GetNumber(),
		URL:    pr.GetHTMLURL(),
		NodeID: pr.GetNodeID(),
		Title:  pr.GetTitle(),
		Body:   pr.GetBody(),
	}, true, nil
}

// defaultBranch resolves the repository's default branch — the base every
// pull request this service opens targets — and caches it for the client's
// whole lifetime. It never changes without a deploy-time repository setting
// change, so re-reading it before every pull request would be a wasted round
// trip.
func (c *Client) defaultBranch(ctx context.Context) (string, error) {
	c.defaultBranchMu.Lock()
	defer c.defaultBranchMu.Unlock()

	if c.defaultBranchCache != "" {
		return c.defaultBranchCache, nil
	}

	repo, _, err := c.api.Repositories.Get(ctx, c.owner, c.repo)
	if err != nil {
		return "", classify(ctx, "reading the repository's default branch", err)
	}
	if repo.GetDefaultBranch() == "" {
		return "", fmt.Errorf("reading the repository's default branch: github returned none")
	}

	c.defaultBranchCache = repo.GetDefaultBranch()
	return c.defaultBranchCache, nil
}

// OpenOrUpdatePullRequest creates the run's pull request the first time its
// branch has anything pushed, and edits it in place on every push after that
// whose title or body actually changed. existing is what a prior
// PullRequestForBranch call already found on this branch — nil means none
// exists yet — so this never re-queries what its caller already knows.
//
// PR ownership moved here from the model (#435): `propose` used to run
// `gh pr create` itself, from inside the sandbox, once, at the end of a fixed
// pipeline. Under the implement/review loop this opens the pull request after
// the FIRST successful push and is never held back waiting for CI or review,
// so a human watching the ticket sees a diff the moment there is one.
func (c *Client) OpenOrUpdatePullRequest(ctx context.Context, branch, title, body string, existing *work.PullRequest) (work.PullRequest, error) {
	if existing == nil {
		return c.createPullRequest(ctx, branch, title, body)
	}
	if existing.Title == title && existing.Body == body {
		// Idempotent no-op: a push that changed nothing implement/review
		// hadn't already told GitHub about must not spend an Edit call it
		// does not need.
		return *existing, nil
	}
	return c.editPullRequest(ctx, *existing, title, body)
}

// createPullRequest opens a new pull request from branch onto the
// repository's default branch.
func (c *Client) createPullRequest(ctx context.Context, branch, title, body string) (work.PullRequest, error) {
	op := fmt.Sprintf("opening a pull request from %s", branch)

	base, err := c.defaultBranch(ctx)
	if err != nil {
		return work.PullRequest{}, err
	}

	pr, _, err := c.api.PullRequests.Create(ctx, c.owner, c.repo, &gh.NewPullRequest{
		Title: gh.Ptr(title),
		Body:  gh.Ptr(body),
		Head:  gh.Ptr(branch),
		Base:  gh.Ptr(base),
		Draft: gh.Ptr(true),
	})
	if err != nil {
		return work.PullRequest{}, classify(ctx, op, err)
	}
	if pr.GetNumber() == 0 || pr.GetHTMLURL() == "" || pr.GetNodeID() == "" {
		return work.PullRequest{}, fmt.Errorf("%s: github returned a pull request with no number, url or node id", op)
	}

	c.log.InfoContext(ctx, "opened the run's pull request", "branch", branch, "pull_request", pr.GetNumber())
	return work.PullRequest{
		Number: pr.GetNumber(),
		URL:    pr.GetHTMLURL(),
		NodeID: pr.GetNodeID(),
		Title:  pr.GetTitle(),
		Body:   pr.GetBody(),
	}, nil
}

// editPullRequest rewrites an existing pull request's title and body.
func (c *Client) editPullRequest(ctx context.Context, existing work.PullRequest, title, body string) (work.PullRequest, error) {
	op := fmt.Sprintf("editing pull request #%d", existing.Number)

	pr, _, err := c.api.PullRequests.Edit(ctx, c.owner, c.repo, existing.Number, &gh.PullRequest{
		Title: gh.Ptr(title),
		Body:  gh.Ptr(body),
	})
	if err != nil {
		return work.PullRequest{}, classify(ctx, op, err)
	}

	c.log.InfoContext(ctx, "edited the run's pull request", "pull_request", existing.Number)
	return work.PullRequest{
		Number: existing.Number,
		URL:    existing.URL,
		NodeID: existing.NodeID,
		Title:  pr.GetTitle(),
		Body:   pr.GetBody(),
	}, nil
}

// TicketDetail returns a ticket with the discussion on it.
//
// By number rather than "the ticket being worked", because a stage that follows
// a reference in an issue body needs exactly this and needs it for a different
// issue. The run's own status comments are removed — unfiltered, a planner
// reads our progress updates back as requirements — and a thread longer than
// the cap keeps its ends and drops its middle.
func (c *Client) TicketDetail(ctx context.Context, number int) (work.TicketDetail, error) {
	op := fmt.Sprintf("reading issue #%d and its comments", number)

	issue, _, err := c.api.Issues.Get(ctx, c.owner, c.repo, number)
	if err != nil {
		return work.TicketDetail{}, classify(ctx, op, err)
	}
	if issue.IsPullRequest() {
		return work.TicketDetail{}, permanent(op, ErrInvalid,
			fmt.Errorf("#%d is a pull request, not an issue", number))
	}

	comments, err := c.threadOf(ctx, op, number)
	if err != nil {
		return work.TicketDetail{}, err
	}
	kept, omitted := trimThread(comments)

	return work.TicketDetail{
		Ticket: work.Ticket{
			Number: issue.GetNumber(),
			Title:  issue.GetTitle(),
			Body:   issue.GetBody(),
		},
		Comments:        kept,
		CommentsOmitted: omitted,
	}, nil
}

// threadOf reads every comment on an issue, oldest first, minus this service's
// own status comments.
func (c *Client) threadOf(ctx context.Context, op string, number int) ([]work.TicketComment, error) {
	botLogin, err := c.botLogin(ctx)
	if err != nil {
		return nil, err
	}

	opts := &gh.IssueListCommentsOptions{
		Sort:        gh.Ptr("created"),
		Direction:   gh.Ptr("asc"),
		ListOptions: gh.ListOptions{PerPage: perPage},
	}

	var thread []work.TicketComment
	for {
		comments, resp, err := c.api.Issues.ListComments(ctx, c.owner, c.repo, number, opts)
		if err != nil {
			return nil, classify(ctx, op, err)
		}
		for _, comment := range comments {
			author := comment.GetUser().GetLogin()
			if isOwnStatus(botLogin, author, comment.GetBody()) {
				continue
			}
			thread = append(thread, work.TicketComment{Author: author, Body: comment.GetBody()})
		}
		if resp.NextPage == 0 {
			return thread, nil
		}
		opts.Page = resp.NextPage
	}
}

// isOwnStatus reports whether a comment is one of this run's status updates,
// which a planner handed the thread unfiltered would read back as requirements.
//
// Authorship decides. The status marker is the fallback for the run where the
// App's identity could not be resolved, and only then: issue text is
// attacker-controllable, so a marker match applied to everyone's comments would
// be a way for a commenter to hide their own text from the stage about to act
// on the ticket. Losing a stranger's marker-carrying comment while we are blind
// to our own name is the smaller failure, and the narrower one.
func isOwnStatus(botLogin, author, body string) bool {
	if botLogin != "" {
		return author == botLogin
	}
	_, isStatus := work.StatusMarkerIn(body)
	return isStatus
}

// trimThread keeps a long thread's ends and reports how much of its middle it
// dropped.
func trimThread(thread []work.TicketComment) ([]work.TicketComment, int) {
	if len(thread) <= maxThreadComments {
		return thread, 0
	}
	tail := maxThreadComments - threadHeadComments
	kept := make([]work.TicketComment, 0, maxThreadComments)
	kept = append(kept, thread[:threadHeadComments]...)
	kept = append(kept, thread[len(thread)-tail:]...)
	return kept, len(thread) - maxThreadComments
}

// PostStatus opens one of the run's status comments, or adopts the one this run
// already opened for that step — the marker in the body decides which.
//
// The guarantee is best-effort de-duplication, not exclusion: GitHub offers no
// conditional create, so two overlapping attempts can both list, both miss and
// both post. What it buys is that the common case — an activity that succeeded
// and was retried after dying before it could record that — produces one
// comment rather than a second, and that a run cannot accumulate a comment per
// attempt on top of the seven it means to post.
//
// Two things about that race got worse when the format moved from one comment
// per run to one per step, and neither is fixed here.
//
// It now runs about seven times per run rather than once, so its odds scale
// with the number of steps and, once the dispatcher works several tickets at
// a time, with concurrency as well.
//
// And a duplicate is no longer self-evident. When a run edited a single
// comment, two comments carrying this service's marker were visibly wrong. Now
// comments are meant to repeat, so a duplicate reads as ordinary — and because
// EditStatus takes one CommentID, the run edits whichever it adopted and the
// loser keeps its "### plan — running" body on the ticket for good, claiming a
// stage is still running long after the run finished.
//
// Fixing it means deciding what to do with the loser, and deleting a comment
// this service posted is an open policy question on #331 rather than something
// to settle in a doc comment. Until it is settled, this is the failure mode to
// recognise: a stage comment stuck at "running" with a sibling that completed.
func (c *Client) PostStatus(ctx context.Context, issue int, body string) (work.CommentID, error) {
	op := fmt.Sprintf("posting the status comment on issue #%d", issue)
	body = capBody(body)

	if marker, ok := work.StatusMarkerIn(body); ok {
		id, found, err := c.findOwnComment(ctx, op, issue, marker)
		if err != nil {
			return 0, err
		}
		if found {
			c.log.InfoContext(ctx, "adopted this run's existing status comment",
				"issue", issue, "comment_id", int64(id))
			return id, nil
		}
	}

	comment, _, err := c.api.Issues.CreateComment(ctx, c.owner, c.repo, issue, &gh.IssueComment{Body: gh.Ptr(body)})
	if err != nil {
		return 0, classify(ctx, op, err)
	}
	c.log.InfoContext(ctx, "posted the run's status comment", "issue", issue, "comment_id", comment.GetID())
	return work.CommentID(comment.GetID()), nil
}

// findOwnComment looks for a comment this run already posted: same marker, and
// written by this App.
//
// Newest first, so a run's own comment is almost always on page one and paging
// usually stops immediately.
func (c *Client) findOwnComment(ctx context.Context, op string, issue int, marker string) (work.CommentID, bool, error) {
	botLogin, err := c.botLogin(ctx)
	if err != nil {
		return 0, false, err
	}
	if botLogin == "" {
		// Adoption is skipped rather than attempted blind. Any human, and any
		// other App, can post a comment carrying this marker; without the author
		// check a run would edit a stranger's comment. A duplicate comment is
		// the smaller failure.
		return 0, false, nil
	}

	opts := &gh.IssueListCommentsOptions{
		Sort:        gh.Ptr("created"),
		Direction:   gh.Ptr("desc"),
		ListOptions: gh.ListOptions{PerPage: perPage},
	}
	for {
		comments, resp, err := c.api.Issues.ListComments(ctx, c.owner, c.repo, issue, opts)
		if err != nil {
			return 0, false, classify(ctx, op, err)
		}
		for _, comment := range comments {
			if comment.GetUser().GetLogin() != botLogin {
				continue
			}
			if found, ok := work.StatusMarkerIn(comment.GetBody()); ok && found == marker {
				return work.CommentID(comment.GetID()), true, nil
			}
		}
		if resp.NextPage == 0 {
			return 0, false, nil
		}
		opts.Page = resp.NextPage
	}
}

// botLogin resolves this App's comment author, or reports it as unresolved.
//
// An empty login with a nil error is deliberate: failing to learn our own name
// must not fail a ticket, so callers degrade — they post rather than adopt, and
// filter a thread by marker alone.
func (c *Client) botLogin(ctx context.Context) (string, error) {
	login, err := c.auth.botLogin(ctx)
	if err != nil {
		c.log.WarnContext(ctx, "could not resolve this app's own identity; treating every comment as someone else's",
			"error", err.Error())
		return "", nil
	}
	return login, nil
}

// EditStatus rewrites the run's status comment in place. Idempotent by
// construction: writing the same body twice is a no-op.
func (c *Client) EditStatus(ctx context.Context, id work.CommentID, body string) error {
	op := fmt.Sprintf("rewriting status comment %d", int64(id))

	_, _, err := c.api.Issues.EditComment(ctx, c.owner, c.repo, int64(id), &gh.IssueComment{Body: gh.Ptr(capBody(body))})
	if err != nil {
		return classify(ctx, op, err)
	}
	return nil
}

// ClearAutoLabel removes `auto`, which the machine does when it has opened a PR
// or given up.
//
// A 404 is NOT assumed to mean the label was already gone. GitHub answers 404
// rather than 403 for a resource in a private repository that a token cannot
// reach, so a revoked installation and a missing grant arrive looking exactly
// like success. Reported as success, `auto` stays on the issue, the dispatcher
// re-lists the ticket on its next poll, and it re-runs forever against the
// quota this whole service is bounded by. So the postcondition is observed
// rather than assumed: re-read the issue and look.
func (c *Client) ClearAutoLabel(ctx context.Context, issue int) error {
	op := fmt.Sprintf("clearing the auto label on issue #%d", issue)

	_, err := c.api.Issues.RemoveLabelForIssue(ctx, c.owner, c.repo, issue, autoLabel)
	if err == nil {
		return nil
	}

	classified := classify(ctx, op, err)
	if !isNotFound(classified) {
		return classified
	}

	// One extra request, on the rare path only.
	current, _, readErr := c.api.Issues.Get(ctx, c.owner, c.repo, issue)
	if readErr != nil {
		verify := classify(ctx, fmt.Sprintf("re-reading issue #%d after a 404 removing the auto label", issue), readErr)
		if isNotFound(verify) {
			return permanent(op, ErrNotFound, fmt.Errorf(
				"github returned 404 and issue #%d cannot be read either: it has been deleted, or this installation can no longer see it", issue))
		}
		return verify
	}

	if hasAutoLabel(current) {
		// The 404 was never about the label. Deliberately loud: the run fails,
		// but `auto` is still on the issue, so whatever dispatches tickets will
		// re-list this one until a human intervenes.
		c.log.ErrorContext(ctx, "the auto label survived a 404 from its own removal",
			"issue", issue, "github_message", messageOf(err))
		return permanent(op, ErrAuth, fmt.Errorf(
			"github returned 404 but the auto label is still on issue #%d: the installation is likely revoked or lacks issues:write", issue))
	}

	c.log.InfoContext(ctx, "the auto label was already absent", "issue", issue)
	return nil
}

// InstallationToken mints a fresh, repository-scoped token for a sandbox to
// push with.
//
// It deliberately bypasses the cache. The cached token has an arbitrary
// remaining lifetime — possibly three minutes — while the implement stage
// pushes a branch up to an hour later.
func (c *Client) InstallationToken(ctx context.Context) (work.SandboxCredential, error) {
	const op = "minting a repository-scoped installation token for the sandbox"

	// Resolved before the token is minted, deliberately: this is a cached read
	// after the first call, and a failure here must not leave a live token
	// minted for a sandbox that never receives it. See work.SandboxCredential
	// for why gh cannot proceed without it.
	identity, err := c.auth.attribution(ctx)
	if err != nil {
		return work.SandboxCredential{}, err
	}

	token, _, err := c.auth.mint(ctx, op, &gh.InstallationTokenOptions{
		Repositories: []string{c.repo},
		Permissions: &gh.InstallationPermissions{
			// implement clones and pushes the branch.
			Contents: gh.Ptr("write"),
			// A push touching .github/workflows is rejected at the git layer
			// without this, with an error that never reaches this client's
			// taxonomy. Agents edit workflows, so this is not hypothetical.
			Workflows: gh.Ptr("write"),
			// OpenOrUpdatePullRequest and the draft-state mutations need it.
			PullRequests: gh.Ptr("write"),
			// GitHub will not grant the others without it.
			Metadata: gh.Ptr("read"),
		},
	})
	if err != nil {
		return work.SandboxCredential{}, err
	}

	// Note what is absent: issues:write, because the WORKER posts status and
	// clears the label — the sandbox runs agent-authored code and has no
	// business writing to the issue — and actions/checks/statuses, because
	// nothing in this pipeline reruns or watches CI.
	c.log.InfoContext(ctx, "minted a repository-scoped installation token for a sandbox",
		"repository", c.repo, "login", identity.Login, "account_id", identity.AccountID)
	return work.SandboxCredential{Token: work.NewCredential(token), Login: identity.Login, AccountID: identity.AccountID}, nil
}

// capBody bounds a comment body at a rune boundary.
func capBody(body string) string {
	if len(body) <= maxCommentBytes {
		return body
	}
	cut := body[:maxCommentBytes-len(truncationNotice)]
	for len(cut) > 0 {
		r, size := utf8.DecodeLastRuneInString(cut)
		if r != utf8.RuneError || size != 1 {
			break
		}
		cut = cut[:len(cut)-1]
	}
	return cut + truncationNotice
}

// hasAutoLabel reports whether an issue still carries `auto`.
func hasAutoLabel(issue *gh.Issue) bool {
	for _, label := range issue.Labels {
		if label.GetName() == autoLabel {
			return true
		}
	}
	return false
}
