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
}

func TestAwaitCIRetriesPendingOrAbsentRequiredChecksAfterFifteenSeconds(t *testing.T) {
	t.Parallel()

	for name, checks := range map[string][]work.CheckRun{
		"pending": {{Name: "build", Completed: false}},
		"absent":  {{Name: "unrelated", Completed: true, Conclusion: "success"}},
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
				t.Fatal("pending or absent required CI must request a retry")
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

type targetChecksGitHub struct {
	fakeGitHub
	checks    []work.CheckRun
	commitSHA string
	calls     int
}

func (f *targetChecksGitHub) ChecksForCommit(_ context.Context, commitSHA string) ([]work.CheckRun, error) {
	f.calls++
	f.commitSHA = commitSHA
	return f.checks, nil
}
