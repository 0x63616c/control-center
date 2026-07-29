package prompts

import (
	"os"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

// TestWorkflowCodeIsForbiddenToImportThisPackage asserts the lint rule that
// keeps Render out of workflow code.
//
// Render mints a fresh nonce from an entropy source on every call. That is
// correct for the fence and fatal for a Temporal replay: a workflow that
// rendered a prompt would produce different bytes on the replay than it did on
// the original execution, and the run would corrupt days after the mistake was
// made, in a stack trace pointing anywhere but here.
//
// Nothing in the code can catch it. The entropy arrives as an injected
// io.Reader, so a workflow calling Render imports no banned package and reads
// as pure orchestration at the call site — depguard's deny list is the whole
// defence, and a deny list is only as good as its entries.
//
// It asserts the configuration rather than running the linter because
// `internal/workflows/` does not exist yet: there is no file for a fixture to
// live in, and a fixture that fails lint on purpose would have to be excluded
// from lint, which is the same hole one layer down. The real linter firing on
// this entry was verified by probe.
func TestWorkflowCodeIsForbiddenToImportThisPackage(t *testing.T) {
	t.Parallel()

	config, err := os.ReadFile("../../.golangci.yml")
	if err != nil {
		t.Fatalf("reading the linter config: %v", err)
	}

	rule := workflowRule(t, string(config))

	// Taken from a type in this package rather than written out, so moving the
	// package fails this test instead of silently emptying the rule.
	self := reflect.TypeOf(Input{}).PkgPath()
	if !strings.Contains(rule, self) {
		t.Errorf("the workflows-are-deterministic rule does not deny %s; workflow code could call Render and corrupt a replay", self)
	}

	// A deny list only fires on the files its rule selects, so the entry above
	// is worth exactly what this selector is worth. Repointing `files:` at a
	// path nothing matches — which is all a rename of internal/workflows/ is —
	// silences the whole rule while leaving every deny entry in place, reading
	// exactly as correct as it does now. That is this test's own failure mode,
	// one field over: a guard that looks present and does nothing.
	//
	// The selector is pinned to a literal deliberately. There is no
	// internal/workflows package yet, so there is nothing to derive it from,
	// and a rename *should* stop here: re-point the config and this line
	// together, as one deliberate act, rather than letting either drift. The
	// config names internal/workflows/ twice — this selector and a
	// containedctx/contextcheck/fatcontext exclusion further down. That one
	// fails loudly (lint noise) rather than silently, but a rename has to move
	// both.
	const selector = `"**/internal/workflows/**"`
	if files := workflowRuleFiles(t, rule); !strings.Contains(files, selector) {
		t.Errorf("the workflows-are-deterministic rule selects %s, not %s; the deny list below it fires on nothing", files, selector)
	}
}

// workflowRule is the body of the workflows-are-deterministic rule: from its
// key to the next rule at the same indentation.
func workflowRule(t *testing.T, config string) string {
	t.Helper()

	const key = "workflows-are-deterministic:"
	_, rest, found := strings.Cut(config, key)
	if !found {
		t.Fatalf("the linter config has no %s rule at all", key)
	}
	// The next sibling rule ends this one. depguard rules sit at eight spaces.
	if at := regexp.MustCompile(`(?m)^ {8}[a-z][a-z0-9-]*:`).FindStringIndex(rest); at != nil {
		return rest[:at[0]]
	}
	return rest
}

// workflowRuleFiles is that rule's `files:` list, up to its next sibling key.
func workflowRuleFiles(t *testing.T, rule string) string {
	t.Helper()

	_, rest, found := strings.Cut(rule, "files:")
	if !found {
		t.Fatalf("the workflows-are-deterministic rule has no files: selector, so it matches nothing")
	}
	// `files:` and `deny:` are siblings at ten spaces.
	if at := regexp.MustCompile(`(?m)^ {10}[a-z][a-z0-9-]*:`).FindStringIndex(rest); at != nil {
		return strings.TrimSpace(rest[:at[0]])
	}
	return strings.TrimSpace(rest)
}
