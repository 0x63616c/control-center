package k8s

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// credentialsPath is where CloneRepo writes the sandbox's git credential file.
//
// It is a sibling of work.RepoDir, deliberately never inside it: RepoDir
// becomes a git working tree the moment it is cloned, and a credential file
// living inside one is one `git add -A` away from being committed into the
// branch the run pushes.
//
// The file is never removed. It has to outlive CloneRepo: `implement` pushes
// from inside the sandbox, as the model, long after this activity has
// returned, and its bare `git push` authenticates through exactly this file
// and the checkout's own local credential.helper config — nothing this
// package controls runs alongside it to hand it a fresher one. See CloneRepo's
// doc for the exposure that acceptance carries and why it is bounded.
const credentialsPath = work.SandboxRoot + "/.git-credentials"

// credentialHelper is the `git -c` value CloneRepo's own clone uses to
// authenticate before any local git config exists to do it instead. git
// treats this exactly as if `git credential-store --file=<path>` had been
// invoked directly; see git-credential-store(1).
const credentialHelper = "credential.helper=" + credentialHelperValue

// credentialHelperValue is credentialHelper's value half, factored out so
// configureCheckoutIdentity's `git config` call and credentialHelper's `git
// -c` form both point at the same file the same way — one spelling of "how
// this checkout finds its credential", not two that could drift apart.
const credentialHelperValue = "store --file=" + credentialsPath

// CloneRepo checks the ticket's repository out at work.RepoDir, on the branch
// the sandbox's own environment names, and pushes it — one operation, because
// a clone with nothing pushed and a pushed branch nothing cloned are both
// useless halves of the same job.
//
// The branch is read from the sandbox's own environment (SF_BRANCH) rather
// than computed here. work.SandboxTemplate.Spec already baked that value into
// this pod when it was created, from the same work.BranchName the rest of the
// run uses, so reading it back is what catches the two ever drifting apart — a
// second, independent call to work.BranchName here would only ever recompute
// the right answer while the pod silently held a different one. Missing or
// empty, this refuses outright: it never falls back to the repository's
// default branch or a detached checkout, either of which would push a run's
// work somewhere nobody asked for it.
//
// It is idempotent under activity retry. An existing checkout already on the
// run's own branch is left in place; anything else at work.RepoDir — absent,
// partial, or on a different branch entirely — is destroyed and redone, which
// is safe because the pod is exclusively this run's. The push is reissued
// regardless of whether the checkout was fresh or reused, which costs nothing
// against a branch already at that state.
//
// # The credential outlives this call, on purpose
//
// implement.md tells the model to push its own commit before it finishes,
// every turn. The workflow reads that push back from GitHub afterward
// (FindPullRequest/OpenOrUpdatePullRequest, #435) rather than a later stage
// reading it from inside the sandbox — but implement itself runs as
// `codex exec` inside the sandbox, well after this activity has returned, and
// may run many turns — so the credential this writes, and the checkout's
// local `credential.helper` config pointing at it (configureCheckoutIdentity),
// have to still be there and still work when they do. A version of this that
// deleted the file once CloneRepo's own push succeeded would leave `implement`
// with nothing to authenticate its own push with, which fails identically to
// #383's original bug: every stage runs, the model commits, the push fails,
// and the run reports itself blocked having spent its whole budget.
//
// What that trades away: the token lives in a file on disk for as long as the
// pod does, not merely for the seconds this call takes. The bound is the pod
// itself — it is exclusively this run's (see the RunID-scoped pod name in
// podspec.go), has AutomountServiceAccountToken: false so nothing inside it
// can reach the Kubernetes API, and is destroyed with the run. Reaching the
// file means an exec into this specific pod, which needs cluster-level access
// already sufficient to do worse — mint a fresh installation token from the
// worker's own App key, or exec into any other sandbox. The token itself is
// repository-scoped, not account-scoped, so what it is worth stealing is push
// access to one repository for up to an hour.
//
// The "up to an hour" matters on its own: GitHub caps an installation token's
// life at one hour, and this is minted once, at the very start of the run,
// before `plan` — the earliest of ADR-0011's five stages, each individually
// budgeted up to work.MaxStageDuration (60 minutes). A run whose earlier
// stages run long can reach `implement` after the token has expired. Nothing
// in this package can refresh it: the sandbox has no path back to the App's
// private key, which never leaves the worker. When that happens, `implement`'s
// own `git push` fails with GitHub's ordinary authentication error, which
// reaches the model as an unexplained non-zero exit from a tool call, not as
// anything this package's error classification ever sees — the failure is
// inside `codex exec`, not inside an activity. That is a real, known
// limitation of clone-once-at-the-start, not a regression this fix
// introduces; solving it needs a way to hand the sandbox a fresher credential
// mid-run, which is out of #383's scope.
func (s *Sandboxes) CloneRepo(ctx context.Context, sandbox work.SandboxID, cloneURL string, credential work.SandboxCredential) error {
	if cloneURL == "" {
		return fmt.Errorf("cloning into sandbox %s: no repository url was configured: %w", sandbox, work.ErrPermanent)
	}

	branch, err := s.sandboxBranch(ctx, sandbox)
	if err != nil {
		return err
	}

	// Written unconditionally, including on a retry that finds a checkout
	// already there: this is also what re-establishes the file after a worker
	// restart resumed a run whose earlier attempt had already written it, and
	// it costs nothing to overwrite a file with the content it already held.
	if err := s.writeCredentials(ctx, sandbox, credential); err != nil {
		return err
	}

	if err := s.ensureCheckout(ctx, sandbox, cloneURL, branch); err != nil {
		return err
	}

	// The checkout's own git config is what a later BARE `git push` — the
	// model's, from inside `codex exec`, with no `-c` this package controls —
	// resolves its credential through. Configured every time, not only on a
	// fresh clone, for the same reason the credential file is rewritten every
	// time: a retry must leave the checkout in the state a first attempt would
	// have, whichever branch of ensureCheckout it took.
	if err := s.configureCheckoutIdentity(ctx, sandbox, credential); err != nil {
		return err
	}

	return s.pushBranch(ctx, sandbox, branch)
}

// sandboxBranch reads SF_BRANCH out of the sandbox's own process environment.
//
// printenv rather than a value threaded in from the workflow: this is the read
// half of the single source, and its whole job is answering what the pod
// actually holds, not what the caller believes it set.
func (s *Sandboxes) sandboxBranch(ctx context.Context, sandbox work.SandboxID) (string, error) {
	var out, stderr bytes.Buffer
	argv := []string{"printenv", work.SandboxBranchEnv}
	code, err := s.exec(ctx, sandbox, argv, nil, &out, &stderr)
	if err != nil {
		return "", fmt.Errorf("reading %s from sandbox %s: %w", work.SandboxBranchEnv, sandbox, err)
	}
	if code != 0 {
		// printenv exits 1 and prints nothing when the variable is unset. That
		// is caught here, loudly and by name, rather than left for git to
		// discover: a `git checkout` with no branch argument stays on whatever
		// the clone defaulted to — this repository's default branch — and a
		// run's work landing there instead of blocked outright is far worse.
		return "", fmt.Errorf(
			"cloning into sandbox %s: %s is not set in the sandbox's own environment, so there is no branch to check out or push to: %w",
			sandbox, work.SandboxBranchEnv, work.ErrPermanent)
	}
	branch := strings.TrimSpace(out.String())
	if branch == "" {
		return "", fmt.Errorf("cloning into sandbox %s: %s is set but empty: %w", sandbox, work.SandboxBranchEnv, work.ErrPermanent)
	}
	return branch, nil
}

// credentialLine is the one line CloneRepo's credential file holds: a
// git-credential-store entry scoped to github.com, in the format
// git-credential-store(1) reads back — https://<user>:<pass>@<host>, one per
// line.
//
// Factored out of writeCredentials so a test can prove the file this package
// actually writes is one a real `git credential fill` resolves, against the
// exact bytes production writes rather than a separately typed copy that
// could drift from them.
func credentialLine(credential work.Credential) string {
	return "https://x-access-token:" + credential.Reveal() + "@github.com\n"
}

// writeCredentials puts a git credential file into the sandbox, scoped to
// github.com and carrying the installation token.
//
// It is written by Write, which streams the content as a tar body rather than
// an argv — the only place the credential's bytes exist outside this call are
// the file itself and the memory holding this string, never an exec argument
// and never a log line.
func (s *Sandboxes) writeCredentials(ctx context.Context, sandbox work.SandboxID, credential work.SandboxCredential) error {
	if err := s.Write(ctx, sandbox, credentialsPath, []byte(credentialLine(credential.Token)), credentialFileMode); err != nil {
		return fmt.Errorf("writing the sandbox's git credential file: %w", err)
	}
	return s.writeGhCredentials(ctx, sandbox, credential)
}

// ghHostsFile is the gh CLI's own credential file, holding the same
// installation token the git credential file above carries.
//
// The duplication is gh's, not ours: it reads GH_TOKEN or this file and never
// git's credential store, so a token that only exists in git's format is a
// token gh cannot see. The old `propose` stage opened the pull request with
// gh (#414); PR creation is now workflow code against go-github (#435), so
// whether the sandbox still needs gh and this file at all is worth
// re-examining — not resolved here.
//
// Written as a file rather than set as GH_TOKEN in the pod's environment,
// deliberately. A pod's environment is in its spec, readable by anything with
// pod-read in the namespace and carried in whatever created it; a file streamed
// in by Write exists only in this call's memory and on the pod's own
// filesystem, which is the property the git credential file was given for the
// same reason.
//
// What this does NOT do is keep the token from the model: the sandbox is one
// container running as one uid, and the stage runs as that uid, so both
// credential files are readable by the agent. That is #416, and it is a known,
// accepted gap rather than an oversight of this function.
//
// The token also expires an hour after it is minted while a run may last six,
// and nothing rewrites either file mid-run — #417.
func ghHostsFile(credential work.SandboxCredential) string {
	// gh's own on-disk shape. The `user` key is REQUIRED, and its absence is not
	// a degraded mode — it is total failure. gh runs a config migration before
	// every command, and that migration resolves the account name by calling
	// /user, which an installation token cannot answer. Measured against gh
	// 2.96.0 with the key absent:
	//
	//	failed to migrate config: cowardly refusing to continue with multi
	//	account migration: couldn't get user name for "github.com"
	//
	// — emitted for `gh auth status` and `gh api` alike, before either ran. With
	// the key present, gh names the account from the file and never asks GitHub
	// who it is.
	return "github.com:\n" +
		"  oauth_token: " + credential.Token.Reveal() + "\n" +
		"  user: " + credential.Login + "\n" +
		"  git_protocol: https\n"
}

// writeGhCredentials puts the gh CLI's hosts.yml into the sandbox.
//
// Same transport and same mode as the git credential file: streamed as a tar
// body by Write, never an exec argument, never a log line.
func (s *Sandboxes) writeGhCredentials(ctx context.Context, sandbox work.SandboxID, credential work.SandboxCredential) error {
	if err := s.Write(ctx, sandbox, work.GhHostsFile, []byte(ghHostsFile(credential)), credentialFileMode); err != nil {
		return fmt.Errorf("writing the sandbox's gh credential file: %w", err)
	}
	return nil
}

// sandboxNoreplyEmail returns the GitHub noreply address associated with a bot
// account's stable numeric ID.
func sandboxNoreplyEmail(credential work.SandboxCredential) string {
	return fmt.Sprintf("%d+%s@users.noreply.github.com", credential.AccountID, credential.Login)
}

// configureCheckoutIdentity points work.RepoDir's own git config at the
// credential file, so anything that later runs `git push` (or any other
// network command) from inside the checkout resolves a credential without
// needing a `-c` flag of its own — which is exactly the shape a model's own
// tool call takes: implement.md tells it to run a bare `git push -u origin
// HEAD`, and this is what makes that push authenticate.
//
// `--local` rather than `--global`: it writes into work.RepoDir/.git/config,
// which is destroyed with the pod along with everything else, rather than a
// home-directory file that would need its own cleanup story.
func (s *Sandboxes) configureCheckoutIdentity(ctx context.Context, sandbox work.SandboxID, credential work.SandboxCredential) error {
	for _, setting := range [][2]string{
		{"credential.helper", credentialHelperValue},
		{"user.name", credential.Login},
		{"user.email", sandboxNoreplyEmail(credential)},
	} {
		if err := s.runExpecting0(ctx, sandbox, "configuring the checkout's "+setting[0],
			[]string{"git", "-C", work.RepoDir, "config", "--local", setting[0], setting[1]}); err != nil {
			return err
		}
	}
	return nil
}

// ensureCheckout makes work.RepoDir a checkout of cloneURL on branch, reusing
// whatever is already there when it already is one.
func (s *Sandboxes) ensureCheckout(ctx context.Context, sandbox work.SandboxID, cloneURL, branch string) error {
	current, ok, err := s.currentBranch(ctx, sandbox)
	if err != nil {
		return err
	}
	if ok {
		if current == branch {
			s.logger.DebugContext(ctx, "sandbox already has a checkout on this run's branch",
				"sandbox", sandbox, "branch", branch)
			return nil
		}
		// The pod is exclusively this run's — see the doc on CloneRepo — so
		// this should never happen. Refusing rather than switching branches out
		// from under whatever is there is the same "fail loudly, never guess"
		// rule the missing-SF_BRANCH case follows.
		return fmt.Errorf(
			"cloning into sandbox %s: %s already holds a checkout on %q, not this run's branch %q: %w",
			sandbox, work.RepoDir, current, branch, work.ErrPermanent)
	}

	// Whatever is at RepoDir, if anything, is not a usable checkout — most
	// likely a previous attempt's clone that failed partway. `git clone`
	// refuses a non-empty destination, so this clears it rather than racing
	// that refusal on every retry.
	if err := s.runExpecting0(ctx, sandbox, "clearing a partial checkout", []string{"rm", "-rf", "--", work.RepoDir}); err != nil {
		return err
	}
	if err := s.runExpecting0(ctx, sandbox, "cloning the repository",
		[]string{"git", "-c", credentialHelper, "clone", cloneURL, work.RepoDir}); err != nil {
		return err
	}
	return s.runExpecting0(ctx, sandbox, "checking out this run's branch",
		[]string{"git", "-C", work.RepoDir, "checkout", "-b", branch})
}

// currentBranch reports the branch work.RepoDir is checked out on, and
// whether it is a checkout at all.
//
// A non-zero exit from git here is read uniformly as "not a usable checkout" —
// RepoDir absent, empty, or present but not a repository all land here rather
// than at a genuine `error`, which is reserved for a transport failure Exec
// itself could not classify. ensureCheckout's clear-then-clone path handles
// every one of those the same way, and a clone that follows will surface a
// deeper problem — permissions on the emptyDir, say — on its own.
func (s *Sandboxes) currentBranch(ctx context.Context, sandbox work.SandboxID) (branch string, ok bool, err error) {
	var out, stderr bytes.Buffer
	argv := []string{"git", "-C", work.RepoDir, "rev-parse", "--abbrev-ref", "HEAD"}
	code, execErr := s.exec(ctx, sandbox, argv, nil, &out, &stderr)
	if execErr != nil {
		return "", false, fmt.Errorf("checking for an existing checkout in sandbox %s: %w", sandbox, execErr)
	}
	if code != 0 {
		return "", false, nil
	}
	return strings.TrimSpace(out.String()), true, nil
}

// pushBranch pushes work.RepoDir's branch to origin, setting the upstream so
// this is the branch a later `git push` inside the sandbox would default to.
//
// It carries no `-c credential.helper` of its own, deliberately: authenticating
// through the checkout's local config, which configureCheckoutIdentity has
// already set, rather than through a flag only this package's own commands
// carry, is what proves the two other things that read no `-c` at all — a
// retried CloneRepo running this same push again, and implement's own bare
// `git push` — will authenticate the same way this one just did.
//
// It is issued whether ensureCheckout cloned fresh or reused an existing
// checkout: pushing a branch already at that state on origin is a no-op
// ("Everything up-to-date"), so the idempotence costs nothing to keep
// unconditional.
func (s *Sandboxes) pushBranch(ctx context.Context, sandbox work.SandboxID, branch string) error {
	return s.runExpecting0(ctx, sandbox, "pushing this run's branch",
		[]string{"git", "-C", work.RepoDir, "push", "-u", "origin", branch})
}

// runExpecting0 executes argv and turns a non-zero exit or a transport failure
// into an error, discarding stdout — every command this file runs this way is
// run for effect, and its evidence on failure is stderr. Despite the name it is
// not git-specific: ensureCheckout also uses it for the rm that clears a
// partial checkout, so both share one place that turns an exit code into a Go
// error.
func (s *Sandboxes) runExpecting0(ctx context.Context, sandbox work.SandboxID, op string, argv []string) error {
	var stderr bytes.Buffer
	code, err := s.exec(ctx, sandbox, argv, nil, io.Discard, &stderr)
	if err != nil {
		return fmt.Errorf("%s in sandbox %s: %w", op, sandbox, err)
	}
	if code != 0 {
		return exitCodeError(sandbox, op, argv, code, stderr.String())
	}
	return nil
}
