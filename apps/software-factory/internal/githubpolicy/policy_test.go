package githubpolicy_test

import (
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/githubpolicy"
)

func TestVerifyRequiresApprovalBypassAndSeparatelyEnforcedChecks(t *testing.T) {
	rulesets := []githubpolicy.Ruleset{
		{
			Name:         "pull request approval",
			Enforcement:  "active",
			Target:       "branch",
			Conditions:   githubpolicy.Conditions{RefName: githubpolicy.RefNameCondition{Include: []string{"refs/heads/main"}}},
			BypassActors: []githubpolicy.BypassActor{{ActorID: 42, ActorType: "Integration", BypassMode: "pull_request"}},
			Rules:        []githubpolicy.Rule{{Type: "pull_request", Parameters: githubpolicy.Parameters{RequiredApprovingReviewCount: 1}}},
		},
		{
			Name:        "required checks",
			Enforcement: "active",
			Target:      "branch",
			Conditions:  githubpolicy.Conditions{RefName: githubpolicy.RefNameCondition{Include: []string{"~DEFAULT_BRANCH"}}},
			Rules:       []githubpolicy.Rule{{Type: "required_status_checks", Parameters: githubpolicy.Parameters{RequiredStatusChecks: []githubpolicy.StatusCheck{{Context: "test"}, {Context: "typecheck"}}}}},
		},
	}

	report := githubpolicy.Verify(rulesets, 42, "main")
	if !report.Ready || report.ApprovalRuleset != "pull request approval" {
		t.Fatalf("Verify() = %+v, want approval bypass to be ready", report)
	}
	if len(report.RequiredChecks) != 2 || report.RequiredChecks[0] != "test" || report.RequiredChecks[1] != "typecheck" {
		t.Fatalf("required checks = %v, want [test typecheck]", report.RequiredChecks)
	}
}

func TestVerifyRejectsChecksInARulesetTheAppCanBypass(t *testing.T) {
	rulesets := []githubpolicy.Ruleset{{
		Name:         "one bypassable ruleset",
		Enforcement:  "active",
		Target:       "branch",
		Conditions:   githubpolicy.Conditions{RefName: githubpolicy.RefNameCondition{Include: []string{"refs/heads/main"}}},
		BypassActors: []githubpolicy.BypassActor{{ActorID: 42, ActorType: "Integration", BypassMode: "pull_request"}},
		Rules: []githubpolicy.Rule{
			{Type: "pull_request", Parameters: githubpolicy.Parameters{RequiredApprovingReviewCount: 1}},
			{Type: "required_status_checks", Parameters: githubpolicy.Parameters{RequiredStatusChecks: []githubpolicy.StatusCheck{{Context: "test"}}}},
		},
	}}

	report := githubpolicy.Verify(rulesets, 42, "main")
	if report.Ready {
		t.Fatalf("Verify() = %+v, want a refusal because the App can bypass the checks too", report)
	}
}

func TestVerifyIgnoresRulesetsThatDoNotTargetTheDeploymentBranch(t *testing.T) {
	rulesets := []githubpolicy.Ruleset{{
		Name:         "release only",
		Enforcement:  "active",
		Target:       "branch",
		Conditions:   githubpolicy.Conditions{RefName: githubpolicy.RefNameCondition{Include: []string{"refs/heads/release"}}},
		BypassActors: []githubpolicy.BypassActor{{ActorID: 42, ActorType: "Integration", BypassMode: "pull_request"}},
		Rules: []githubpolicy.Rule{
			{Type: "pull_request", Parameters: githubpolicy.Parameters{RequiredApprovingReviewCount: 1}},
			{Type: "required_status_checks", Parameters: githubpolicy.Parameters{RequiredStatusChecks: []githubpolicy.StatusCheck{{Context: "test"}}}},
		},
	}}

	report := githubpolicy.Verify(rulesets, 42, "main")
	if report.Ready {
		t.Fatalf("Verify() = %+v, want off-branch rules ignored", report)
	}
}
