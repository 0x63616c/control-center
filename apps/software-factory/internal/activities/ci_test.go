package activities

import (
	"context"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

func TestObserveCIReportsGreenWhenEveryCheckPasses(t *testing.T) {
	t.Parallel()

	gh := &fakeGitHub{checks: []work.CheckRun{
		{Name: "build", Completed: true, Conclusion: "success"},
		{Name: "lint", Completed: true, Conclusion: "neutral"},
	}}
	d := deps()
	d.GitHub = gh
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.ObserveCI)

	val, err := e.ExecuteActivity(a.ObserveCI, ObserveCIInput{Branch: "software-factory/ticket-328/run-1", Bound: time.Minute})
	if err != nil {
		t.Fatalf("ObserveCI: %v", err)
	}
	var out ObserveCIOutput
	if err := val.Get(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !out.Concluded || !out.Green {
		t.Fatalf("out = %+v, want concluded and green", out)
	}
	if len(out.RedChecks) != 0 {
		t.Fatalf("RedChecks = %v, want none", out.RedChecks)
	}
	if gh.checksRef != "software-factory/ticket-328/run-1" {
		t.Fatalf("asked github about %q, want the run's branch", gh.checksRef)
	}
}

func TestObserveCIReportsRedCheckIdentities(t *testing.T) {
	t.Parallel()

	gh := &fakeGitHub{checks: []work.CheckRun{
		{Name: "build", Completed: true, Conclusion: "success"},
		{Name: "test", FailureFingerprint: "failure-a", Completed: true, Conclusion: "failure"},
	}}
	d := deps()
	d.GitHub = gh
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.ObserveCI)

	val, err := e.ExecuteActivity(a.ObserveCI, ObserveCIInput{Branch: "b", Bound: time.Minute})
	if err != nil {
		t.Fatalf("ObserveCI: %v", err)
	}
	var out ObserveCIOutput
	if err := val.Get(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !out.Concluded || out.Green {
		t.Fatalf("out = %+v, want concluded and red", out)
	}
	if len(out.RedChecks) != 1 || out.RedChecks[0] != "test" {
		t.Fatalf("RedChecks = %v, want [test]", out.RedChecks)
	}
	if want := (work.CheckFailure{Name: "test", Fingerprint: "failure-a"}); len(out.RedFailures) != 1 || out.RedFailures[0] != want {
		t.Fatalf("RedFailures = %v, want [%+v]", out.RedFailures, want)
	}
}

func TestObserveCIPollsUntilConcludedRatherThanReadingAnInFlightRun(t *testing.T) {
	t.Parallel()

	pending := []work.CheckRun{{Name: "build", Completed: false}}
	done := []work.CheckRun{{Name: "build", Completed: true, Conclusion: "success"}}

	calls := 0
	gh := &pollingFakeGitHub{
		fakeGitHub: fakeGitHub{},
		onCall: func(n int) ([]work.CheckRun, error) {
			calls = n
			if n < 3 {
				return pending, nil
			}
			return done, nil
		},
	}
	d := deps()
	d.GitHub = gh
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.ObserveCI)

	val, err := e.ExecuteActivity(a.ObserveCI, ObserveCIInput{Branch: "b", Bound: time.Hour})
	if err != nil {
		t.Fatalf("ObserveCI: %v", err)
	}
	var out ObserveCIOutput
	if err := val.Get(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !out.Concluded || !out.Green {
		t.Fatalf("out = %+v, want concluded and green once the check settles", out)
	}
	if calls < 3 {
		t.Fatalf("called github %d times, want at least 3 (poll until concluded)", calls)
	}
}

func TestObserveCIReportsUnobservedWhenItsBoundElapsesFirst(t *testing.T) {
	t.Parallel()

	// Every call reports the same still-running check; ObserveCI must give
	// up once the fake clock's Sleep has advanced past Bound rather than
	// polling forever.
	gh := &fakeGitHub{checks: []work.CheckRun{{Name: "build", Completed: false}}}
	d := deps()
	d.GitHub = gh
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.ObserveCI)

	val, err := e.ExecuteActivity(a.ObserveCI, ObserveCIInput{Branch: "b", Bound: 2 * ciPollInterval})
	if err != nil {
		t.Fatalf("ObserveCI: %v", err)
	}
	var out ObserveCIOutput
	if err := val.Get(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Concluded {
		t.Fatalf("out = %+v, want unobserved once the bound elapses with nothing concluded", out)
	}
	if len(out.RedChecks) != 0 {
		t.Fatalf("an unobserved result must report no red checks of its own: got %v", out.RedChecks)
	}
}

func TestObserveCITreatsNoCheckRunsAsNotYetConcluded(t *testing.T) {
	t.Parallel()

	// CI may not have started reporting anything yet — that is exactly as
	// inconclusive as a check stuck in_progress, not a green pass by default.
	gh := &fakeGitHub{checks: nil}
	d := deps()
	d.GitHub = gh
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.ObserveCI)

	val, err := e.ExecuteActivity(a.ObserveCI, ObserveCIInput{Branch: "b", Bound: ciPollInterval})
	if err != nil {
		t.Fatalf("ObserveCI: %v", err)
	}
	var out ObserveCIOutput
	if err := val.Get(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Concluded {
		t.Fatalf("out = %+v, want unobserved: no check runs is not a green pass", out)
	}
}

func TestObserveCIRefusesAZeroBoundRatherThanReportingUnobservedForFree(t *testing.T) {
	t.Parallel()

	d := deps()
	e := env(t)
	a := mustNew(t, d)
	e.RegisterActivity(a.ObserveCI)

	_, err := e.ExecuteActivity(a.ObserveCI, ObserveCIInput{Branch: "b"})
	if err == nil {
		t.Fatal("a zero bound must be refused: it would report unobserved without ever asking github")
	}
}

// pollingFakeGitHub lets a test vary ChecksForRef's answer call by call, to
// prove ObserveCI actually polls rather than trusting its first snapshot.
type pollingFakeGitHub struct {
	fakeGitHub
	n      int
	onCall func(call int) ([]work.CheckRun, error)
}

func (f *pollingFakeGitHub) ChecksForRef(context.Context, string) ([]work.CheckRun, error) {
	f.n++
	return f.onCall(f.n)
}
