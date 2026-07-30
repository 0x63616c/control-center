package k8s

import (
	"context"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// TestWriteCodexCredentialIsANoOpThatNeverTouchesTheCluster proves the D3
// (#434) redesign: the codex credential now reaches the sandbox through a
// mounted Secret CreateSandbox provisions (see lifecycle_test.go's
// TestCreateWritesTheCodexCredentialIntoAPerTicketSecret and podspec_test.go's
// mount assertions), so this call has nothing left to do and must never
// reach the apiserver to do it.
func TestWriteCodexCredentialIsANoOpThatNeverTouchesTheCluster(t *testing.T) {
	t.Parallel()

	s, cs, _ := newLifecycleSandboxes(t)

	doc := []byte(`{"tokens":{"access_token":"unused"}}`)
	if err := s.WriteCodexCredential(context.Background(), testSandbox, work.NewCredentialFile(doc)); err != nil {
		t.Fatalf("WriteCodexCredential returned an unexpected error: %v", err)
	}
	if len(cs.Actions()) != 0 {
		t.Errorf("actions = %v, want none: a no-op must never reach the apiserver", verbs(cs))
	}
}
