package k8s

import (
	"context"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// WriteCodexCredential is a deliberate no-op. It implements
// activities.CredentialWriter only so *Sandboxes keeps satisfying that
// interface — cmd/worker's composition root still wires CredentialWriter to
// this client, and that assignment must keep compiling — but there is nothing
// left for it to do.
//
// Before #434's step 3 (D3), this streamed file's content into the sandbox
// over pods/exec, the same tar transport this package used for every other
// write into a running pod. That transport is gone: RunStage now runs inside
// the sandbox pod's own process, not reached remotely, so there is no exec
// left to stream a tar body over.
//
// D3 replaces it with a per-ticket Kubernetes Secret: CreateSandbox (see
// lifecycle.go's ensureCredentialSecret) writes the codex credential document
// into that Secret before the pod exists, and buildPod (podspec.go) mounts it
// directly at work.CodexAuthFile via a subPath volume mount. Kubernetes
// itself puts the file in place at container start — before any activity,
// including this one, ever runs — so by the time a workflow reaches this
// call the file is already there. See activities.Activities.WriteCodexCredential's
// own doc comment for why the activity that calls this is kept, unchanged,
// rather than removed: internal/workflows/workticket.go still calls it, and
// this package's ownership for this slice does not extend to that file.
func (s *Sandboxes) WriteCodexCredential(context.Context, work.SandboxID, work.CredentialFile) error {
	return nil
}
