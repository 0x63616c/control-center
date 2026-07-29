package main

import (
	"os"
	"strings"
	"testing"
)

// TestNewActivitiesWiresTheCodexCredentialSeam is the source-level assertion
// that closes #398: TokenSource and CredentialWriter used to be an interface
// and an implementation with nothing between them, and this is the check that
// stops a future refactor silently reopening that gap.
//
// It reads main.go's source rather than executing newActivities, for the same
// reason TestRegisterRegistersBothWorkflowsAndTheActivities does: newActivities
// dials Kubernetes and reads process configuration, neither of which exists
// in a unit test, so the composition itself is what this checks — not its
// runtime behaviour, which activities.TestNewNamesEveryDependencyItIsMissing
// and the codexauth package's own tests already cover.
func TestNewActivitiesWiresTheCodexCredentialSeam(t *testing.T) {
	t.Parallel()

	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("reading main.go: %v", err)
	}
	body := extractFuncBody(t, string(source), "func newActivities(")

	for _, want := range []string{
		"newCodexAuthSource(",
		"TokenSource:",
		"CredentialWriter: sandboxes",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("newActivities()'s body does not contain %q; the codex credential seam is unwired again (#398)", want)
		}
	}
}

// TestSandboxTemplateCarriesCodexHome asserts CODEX_HOME is set on every
// sandbox's template, not left to the deploy to remember: #398 found this
// silently absent, with codex exec failing identically to a model failure.
func TestSandboxTemplateCarriesCodexHome(t *testing.T) {
	t.Parallel()

	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("reading main.go: %v", err)
	}
	body := extractFuncBody(t, string(source), "func newActivities(")

	if !strings.Contains(body, "work.CodexHomeEnv: work.CodexHomeDir") {
		t.Error("newActivities()'s sandbox template does not set CODEX_HOME; codex exec in the sandbox has nowhere to read its credential from")
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
