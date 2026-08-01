package workflows

import (
	"errors"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/sdk/temporal"
)

func TestRemainingSessionExecutionTimeoutUsesOneAbsoluteDeadline(t *testing.T) {
	t.Parallel()
	deadline := time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC)

	first, err := remainingSessionExecutionTimeout(deadline.Add(-20*time.Hour), deadline)
	if err != nil || first != 20*time.Hour {
		t.Fatalf("initial remaining timeout = %s, %v; want 20h", first, err)
	}
	replacement, err := remainingSessionExecutionTimeout(deadline.Add(-time.Hour), deadline)
	if err != nil || replacement != time.Hour {
		t.Fatalf("replacement remaining timeout = %s, %v; want 1h from the original deadline", replacement, err)
	}

	_, err = remainingSessionExecutionTimeout(deadline, deadline)
	var application *temporal.ApplicationError
	if !errors.As(err, &application) || application.Type() != activities.ErrTypeHardDeadline {
		t.Fatalf("elapsed deadline error = %v, want typed %q", err, activities.ErrTypeHardDeadline)
	}
}

func TestWorkOnTicketExecutionTimeoutExposesThePolicyHardDeadline(t *testing.T) {
	t.Parallel()
	policy := work.DefaultTargetRunPolicy()
	policy.HardDeadline = 30 * time.Hour
	if got := WorkOnTicketExecutionTimeout(policy); got != 30*time.Hour {
		t.Fatalf("execution timeout = %s, want 30h", got)
	}
}
