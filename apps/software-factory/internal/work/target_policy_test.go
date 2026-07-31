package work_test

import (
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

func TestDefaultTargetRunPolicyEncodesTheTargetBudgets(t *testing.T) {
	t.Parallel()

	policy := work.DefaultTargetRunPolicy()
	if err := policy.Validate(); err != nil {
		t.Fatalf("default target policy validates: %v", err)
	}
	if policy.MaxReviewSteps != 5 {
		t.Fatalf("MaxReviewSteps = %d, want 5", policy.MaxReviewSteps)
	}
	if policy.MaxAgentAttempts != 25 {
		t.Fatalf("MaxAgentAttempts = %d, want 25", policy.MaxAgentAttempts)
	}
	if policy.Agent.StartToCloseTimeout != 55*time.Minute {
		t.Fatalf("agent StartToCloseTimeout = %s, want 55m", policy.Agent.StartToCloseTimeout)
	}
	if policy.Agent.ScheduleToCloseTimeout != 90*time.Minute {
		t.Fatalf("agent ScheduleToCloseTimeout = %s, want 90m", policy.Agent.ScheduleToCloseTimeout)
	}
	if policy.Agent.HeartbeatTimeout != 5*time.Minute {
		t.Fatalf("agent HeartbeatTimeout = %s, want 5m", policy.Agent.HeartbeatTimeout)
	}
	if got := policy.Agent.Retry; got.MaximumAttempts != 10 || got.InitialInterval != 10*time.Second ||
		got.BackoffCoefficient != 2 || got.MaximumInterval != 5*time.Minute {
		t.Fatalf("agent retry = %+v, want 10 tries, 10s x2 capped at 5m", got)
	}
	if policy.SemanticDeadline >= policy.HardDeadline {
		t.Fatalf("semantic deadline %s must leave a finalization buffer before hard deadline %s", policy.SemanticDeadline, policy.HardDeadline)
	}
}

func TestTargetRunPolicyRejectsAnEmptyRequiredCheckSet(t *testing.T) {
	t.Parallel()

	policy := work.DefaultTargetRunPolicy()
	policy.RequiredChecks = nil

	if err := policy.Validate(); err == nil {
		t.Fatal("a target run without explicit required checks must be rejected")
	}
}

func TestTargetRunPolicyHasNamedPoliciesForEachFailureDomain(t *testing.T) {
	t.Parallel()

	policy := work.DefaultTargetRunPolicy()
	policies := map[string]work.ActivityPolicy{
		"await ci":            policy.AwaitCI,
		"merge":               policy.Merge,
		"provisioning":        policy.Provisioning,
		"credential rotation": policy.CredentialRotation,
		"recording":           policy.Recording,
		"teardown":            policy.Teardown,
	}
	for name, activityPolicy := range policies {
		if err := activityPolicy.Validate(name); err != nil {
			t.Fatalf("%s policy invalid: %v", name, err)
		}
	}
}

func TestTargetRunPolicyRejectsAHardDeadlineWithoutFinalizationRoom(t *testing.T) {
	t.Parallel()

	policy := work.DefaultTargetRunPolicy()
	policy.HardDeadline = policy.SemanticDeadline

	if err := policy.Validate(); err == nil {
		t.Fatal("a target run needs a distinct hard deadline for finalization")
	}
}
