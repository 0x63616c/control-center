package activities

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/sdk/temporal"
)

// awaitCIRetryDelay keeps expected check settlement out of workflow history.
const awaitCIRetryDelay = 15 * time.Second

// AwaitCIInput identifies the immutable candidate commit and the configured
// checks allowed to authorize it.
type AwaitCIInput struct {
	CommitSHA      string
	RequiredChecks []string
}

// AwaitCIOutput is the authoritative concluded required-check result. A red
// result includes bounded evidence for the next Implement Step.
type AwaitCIOutput struct {
	CommitSHA   string
	Green       bool
	RedFailures []work.CheckFailure
}

// AwaitCI reads exactly one GitHub check snapshot for an immutable commit. It
// neither polls nor sleeps: Temporal retries expected waiting without creating
// another semantic Step or Agent Attempt.
func (a *Activities) AwaitCI(ctx context.Context, in AwaitCIInput) (AwaitCIOutput, error) {
	if err := validateAwaitCIInput(in); err != nil {
		return AwaitCIOutput{}, fail(ctx, "awaiting CI", err)
	}
	checks, err := a.deps.GitHub.ChecksForCommit(ctx, in.CommitSHA, in.RequiredChecks)
	if err != nil {
		return AwaitCIOutput{}, fail(ctx, fmt.Sprintf("awaiting CI for commit %s", in.CommitSHA), err)
	}
	green, failures := reduceRequiredChecks(checks, in.RequiredChecks)
	if !green && failures == nil {
		return AwaitCIOutput{}, temporal.NewApplicationErrorWithOptions(
			fmt.Sprintf("CI for commit %s has not concluded for every required check", in.CommitSHA),
			ErrTypeCINotConcluded, temporal.ApplicationErrorOptions{NextRetryDelay: awaitCIRetryDelay})
	}
	return AwaitCIOutput{CommitSHA: in.CommitSHA, Green: green, RedFailures: failures}, nil
}

func validateAwaitCIInput(in AwaitCIInput) error {
	if strings.TrimSpace(in.CommitSHA) == "" {
		return fmt.Errorf("an exact commit SHA is required: %w", work.ErrPermanent)
	}
	if len(in.RequiredChecks) == 0 {
		return fmt.Errorf("a non-empty explicit required-check set is required: %w", work.ErrPermanent)
	}
	seen := make(map[string]struct{}, len(in.RequiredChecks))
	for _, check := range in.RequiredChecks {
		if strings.TrimSpace(check) == "" {
			return fmt.Errorf("required check name is empty: %w", work.ErrPermanent)
		}
		if _, exists := seen[check]; exists {
			return fmt.Errorf("required check %q appears more than once: %w", check, work.ErrPermanent)
		}
		seen[check] = struct{}{}
	}
	return nil
}

// reduceRequiredChecks evaluates only policy-named checks. nil failures means
// an expected wait, which keeps an absent or pending required check from being
// replaced by an unrelated green result.
func reduceRequiredChecks(checks []work.CheckRun, required []string) (green bool, failures []work.CheckFailure) {
	byName := make(map[string][]work.CheckRun, len(checks))
	for _, check := range checks {
		byName[check.Name] = append(byName[check.Name], check)
	}

	var (
		red     []work.CheckFailure
		waiting bool
	)
	for _, name := range required {
		runs := byName[name]
		if len(runs) == 0 {
			waiting = true
			continue
		}
		for _, check := range runs {
			if !check.Completed || check.Superseded() {
				waiting = true
				continue
			}
			if !check.Green() {
				red = append(red, work.CheckFailure{
					Name: name, Fingerprint: check.FailureFingerprint, Evidence: check.FailureEvidence,
				})
			}
		}
	}
	if len(red) == 0 {
		if waiting {
			return false, nil
		}
		return true, []work.CheckFailure{}
	}
	return false, red
}
