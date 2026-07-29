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

	deny := workflowDenyList(t, string(config))
	// Taken from a type in this package rather than written out, so moving the
	// package fails this test instead of silently emptying the rule.
	self := reflect.TypeOf(Input{}).PkgPath()
	if !strings.Contains(deny, self) {
		t.Errorf("the workflows-are-deterministic rule does not deny %s; workflow code could call Render and corrupt a replay", self)
	}
}

// workflowDenyList is the body of the workflows-are-deterministic rule: from
// its key to the next rule at the same indentation.
func workflowDenyList(t *testing.T, config string) string {
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
