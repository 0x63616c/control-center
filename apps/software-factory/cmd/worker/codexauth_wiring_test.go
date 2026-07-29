package main

import (
	"os"
	"strings"
	"testing"
)

// TestNewActivitiesBuildsTheCodexCredentialSource is the source-level
// assertion that newActivities still constructs the codex token source and
// hands it to buildDeps — the half of #398's seam that
// TestBuildDepsSatisfiesActivitiesNew cannot see, because that test calls
// buildDeps directly with a hand-supplied TokenSource and would stay green
// even if newActivities stopped building a real one.
//
// It reads main.go's source rather than executing newActivities, for the same
// reason TestRegisterRegistersBothWorkflowsAndTheActivities does: newActivities
// dials Kubernetes and reads process configuration, neither of which exists
// in a unit test.
func TestNewActivitiesBuildsTheCodexCredentialSource(t *testing.T) {
	t.Parallel()

	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("reading main.go: %v", err)
	}
	body := extractFuncBody(t, string(source), "func newActivities(")

	if !strings.Contains(body, "newCodexAuthSource(") {
		t.Error("newActivities()'s body does not call newCodexAuthSource; the codex credential seam is unwired again (#398)")
	}
}

// TestBuildDepsWiresTheCodexCredentialSeam is the source-level companion to
// TestBuildDepsSatisfiesActivitiesNew: that test proves the Deps buildDeps
// returns is one activities.New accepts, which already fails loudly if
// TokenSource or CredentialWriter go nil, but it would stay green even if
// buildDeps silently swapped in the wrong CredentialWriter (Pods, say,
// instead of sandboxes) — anything non-nil satisfies presence. This checks
// the actual wiring, not just that something was plugged in.
func TestBuildDepsWiresTheCodexCredentialSeam(t *testing.T) {
	t.Parallel()

	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("reading main.go: %v", err)
	}
	body := extractFuncBody(t, string(source), "func buildDeps(")

	for _, want := range []string{
		"TokenSource:      tokenSource",
		"CredentialWriter: sandboxes",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("buildDeps()'s body does not contain %q; the codex credential seam is unwired again (#398)", want)
		}
	}
}

// TestSandboxTemplateCarriesCodexHome asserts CODEX_HOME is set on every
// sandbox's template, not left to the deploy to remember: #398 found this
// silently absent, with codex exec failing identically to a model failure.
// TestBuildDepsSatisfiesActivitiesNew does not cover this — SandboxTemplate's
// own Validate checks Image, the resource limits and the deadline, never Env.
func TestSandboxTemplateCarriesCodexHome(t *testing.T) {
	t.Parallel()

	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("reading main.go: %v", err)
	}
	body := extractFuncBody(t, string(source), "func buildDeps(")

	if !strings.Contains(body, "work.CodexHomeEnv: work.CodexHomeDir") {
		t.Error("buildDeps()'s sandbox template does not set CODEX_HOME; codex exec in the sandbox has nowhere to read its credential from")
	}
}

// extractFuncBody returns the text of the named top-level function, so an
// assertion cannot pass by matching text anywhere else in the file. It does
// not handle a function containing a nested "\n}\n" of its own (a func
// literal at statement level) — none of the functions this file inspects has
// one.
func extractFuncBody(t *testing.T, source, signature string) string {
	t.Helper()

	start := strings.Index(source, signature)
	if start < 0 {
		t.Fatalf("main.go has no %q", signature)
	}
	end := strings.Index(source[start:], "\n}\n")
	if end < 0 {
		t.Fatalf("could not find the end of %s", signature)
	}
	return source[start : start+end]
}
