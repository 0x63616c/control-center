package activities

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/sdk/temporal"
)

func TestAwaitCIReadsOneExactCommitSnapshotAndReturnsGreenRequiredChecks(t *testing.T) {
	t.Parallel()

	gh := &targetChecksGitHub{checks: []work.CheckRun{
		{Name: "build", Completed: true, Conclusion: "success"},
		{Name: "lint", Completed: true, Conclusion: "neutral"},
		{Name: "unrelated", Completed: true, Conclusion: "failure"},
	}}
	d := deps()
	d.GitHub = gh
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.AwaitCI)

	value, err := e.ExecuteActivity(a.AwaitCI, AwaitCIInput{CommitSHA: "abc123", RequiredChecks: []string{"build", "lint"}})
	if err != nil {
		t.Fatalf("AwaitCI: %v", err)
	}
	var out AwaitCIOutput
	if err := value.Get(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !out.Green || out.CommitSHA != "abc123" {
		t.Fatalf("out = %+v, want green result for exact commit", out)
	}
	if gh.commitSHA != "abc123" || gh.calls != 1 {
		t.Fatalf("github calls = %d for %q, want one snapshot for abc123", gh.calls, gh.commitSHA)
	}
	if len(gh.requiredChecks) != 2 || gh.requiredChecks[0] != "build" || gh.requiredChecks[1] != "lint" {
		t.Fatalf("required checks = %v, want the configured build and lint checks", gh.requiredChecks)
	}
}

func TestAwaitCIRetriesUnconcludedRequiredChecksAfterFifteenSeconds(t *testing.T) {
	t.Parallel()

	for name, checks := range map[string][]work.CheckRun{
		"pending":   {{Name: "build", Completed: false}},
		"absent":    {{Name: "unrelated", Completed: true, Conclusion: "success"}},
		"cancelled": {{Name: "build", Completed: true, Conclusion: "cancelled"}},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			gh := &targetChecksGitHub{checks: checks}
			d := deps()
			d.GitHub = gh
			e := env(t)
			a := mustNew(t, d)
			e.RegisterActivity(a.AwaitCI)

			_, err := e.ExecuteActivity(a.AwaitCI, AwaitCIInput{CommitSHA: "abc123", RequiredChecks: []string{"build"}})
			if err == nil {
				t.Fatal("unconcluded required CI must request a retry")
			}
			var app *temporal.ApplicationError
			if !errors.As(err, &app) {
				t.Fatalf("error %T, want ApplicationError: %v", err, err)
			}
			if app.Type() != ErrTypeCINotConcluded || app.NextRetryDelay() != 15*time.Second || app.NonRetryable() {
				t.Fatalf("error = type %q delay %s nonRetryable %t, want retryable 15s CI wait", app.Type(), app.NextRetryDelay(), app.NonRetryable())
			}
			if gh.calls != 1 {
				t.Fatalf("github calls = %d, want exactly one snapshot per activity try", gh.calls)
			}
		})
	}
}

func TestAwaitCIReturnsRequiredRedEvidenceWithoutLettingUnrelatedGreenPass(t *testing.T) {
	t.Parallel()

	gh := &targetChecksGitHub{checks: []work.CheckRun{
		{Name: "required", Completed: true, Conclusion: "failure", FailureFingerprint: "fingerprint", FailureEvidence: "bounded evidence"},
		{Name: "unrelated", Completed: true, Conclusion: "success"},
	}}
	d := deps()
	d.GitHub = gh
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.AwaitCI)

	value, err := e.ExecuteActivity(a.AwaitCI, AwaitCIInput{CommitSHA: "abc123", RequiredChecks: []string{"required"}})
	if err != nil {
		t.Fatalf("AwaitCI: %v", err)
	}
	var out AwaitCIOutput
	if err := value.Get(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Green || len(out.RedFailures) != 1 {
		t.Fatalf("out = %+v, want one authoritative required failure", out)
	}
	if got := out.RedFailures[0]; got.Name != "required" || got.Fingerprint != "fingerprint" || got.Evidence != "bounded evidence" {
		t.Fatalf("failure = %+v, want bounded required evidence", got)
	}
}

func TestAwaitCIRedWinsWhenAnotherRequiredCheckIsPendingOrAbsent(t *testing.T) {
	t.Parallel()

	for name, required := range map[string][]string{
		"red before pending": {"red", "pending"},
		"pending before red": {"pending", "red"},
		"red before absent":  {"red", "absent"},
		"absent before red":  {"absent", "red"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			gh := &targetChecksGitHub{checks: []work.CheckRun{
				{Name: "pending", Completed: false},
				{Name: "red", Completed: true, Conclusion: "failure", FailureFingerprint: "failure-id", FailureEvidence: "bounded failure"},
			}}
			d := deps()
			d.GitHub = gh
			e := env(t)
			a := mustNew(t, d)
			e.RegisterActivity(a.AwaitCI)

			value, err := e.ExecuteActivity(a.AwaitCI, AwaitCIInput{CommitSHA: "abc123", RequiredChecks: required})
			if err != nil {
				t.Fatalf("AwaitCI: %v", err)
			}
			var out AwaitCIOutput
			if err := value.Get(&out); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if out.Green || len(out.RedFailures) != 1 {
				t.Fatalf("out = %+v, want the required red result despite another incomplete check", out)
			}
			if got := out.RedFailures[0]; got.Name != "red" || got.Fingerprint != "failure-id" || got.Evidence != "bounded failure" {
				t.Fatalf("failure = %+v, want preserved bounded red evidence", got)
			}
			if gh.calls != 1 {
				t.Fatalf("github calls = %d, want one complete snapshot", gh.calls)
			}
		})
	}
}

type targetChecksGitHub struct {
	fakeGitHub
	checks         []work.CheckRun
	commitSHA      string
	requiredChecks []string
	calls          int
}

func (f *targetChecksGitHub) ChecksForCommit(_ context.Context, commitSHA string, requiredChecks []string) ([]work.CheckRun, error) {
	f.calls++
	f.commitSHA = commitSHA
	f.requiredChecks = append([]string(nil), requiredChecks...)
	return f.checks, nil
}
