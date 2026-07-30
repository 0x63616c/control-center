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
// TokenSource goes nil, but it would stay green even if buildDeps silently
// swapped in the wrong TokenSource — anything non-nil satisfies presence.
// This checks the actual wiring, not just that something was plugged in.
func TestBuildDepsWiresTheCodexCredentialSeam(t *testing.T) {
	t.Parallel()

	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("reading main.go: %v", err)
	}
	body := extractFuncBody(t, string(source), "func buildDeps(")

	if want := "TokenSource: tokenSource"; !strings.Contains(body, want) {
		t.Errorf("buildDeps()'s body does not contain %q; the codex credential seam is unwired again (#398)", want)
	}
}

// TestSandboxTemplateCarriesItsPathEnvironment asserts the sandbox template
// sets every environment variable the image is a contract with, not left to the
// deploy to remember: #398 found CODEX_HOME silently absent, with codex exec
// failing identically to a model failure, and GH_CONFIG_DIR fails the same way
// — gh falls back to $HOME/.config/gh, finds no credential there, and `propose`
// reports itself blocked (#414). Extended for #434 step 3: the sandbox pod's
// own embedded worker needs the same Temporal frontend and namespace this
// process itself dials, copied from cfg rather than a second pair of
// environment variables invented for it.
//
// TestBuildDepsSatisfiesActivitiesNew does not cover this — SandboxTemplate's
// own Validate checks Image, the resource limits and the deadline, never Env.
func TestSandboxTemplateCarriesItsPathEnvironment(t *testing.T) {
	t.Parallel()

	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("reading main.go: %v", err)
	}
	// Whitespace-collapsed before matching: gofmt aligns the values of a
	// multi-entry map literal, so an assertion on the exact spacing would fail
	// the next time an entry with a longer key is added.
	body := collapseSpace(extractFuncBody(t, string(source), "func buildDeps("))

	for _, tc := range []struct{ entry, why string }{
		{
			"work.CodexHomeEnv: work.CodexHomeDir",
			"codex exec in the sandbox has nowhere to read its credential from",
		},
		{
			"work.GhConfigDirEnv: work.GhConfigDir",
			"gh looks in $HOME/.config/gh instead, finds no credential, and propose cannot open the pull request",
		},
		{
			"work.SandboxTemporalHostPortEnv: cfg.TemporalHostPort",
			"the sandbox pod's own embedded worker (#434) has no Temporal frontend to dial and CreateSession's CreationTimeout is all a run would ever see",
		},
		{
			"work.SandboxTemporalNamespaceEnv: cfg.TemporalNamespace",
			"the sandbox pod's own embedded worker would dial the wrong namespace, or none",
		},
	} {
		if !strings.Contains(body, tc.entry) {
			t.Errorf("buildDeps()'s sandbox template does not set %s; %s", tc.entry, tc.why)
		}
	}
}

// collapseSpace reduces every run of whitespace to a single space, so a match
// against source text is insensitive to gofmt's alignment.
func collapseSpace(s string) string {
	return strings.Join(strings.Fields(s), " ")
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
