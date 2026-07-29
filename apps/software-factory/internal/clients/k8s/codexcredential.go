package k8s

import (
	"context"
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// WriteCodexCredential puts the codex CLI's auth.json into the sandbox at
// work.CodexAuthFile, so codex exec can authenticate. It implements
// activities.CredentialWriter.
//
// It is written by Write, which streams the content as a tar body rather than
// an argv or a pod spec field — the only place the document's bytes exist
// outside this call are the file itself and the memory holding the
// work.CredentialFile, never an exec argument and never a log line. See
// Write's own doc comment for why a tar header carries the mode instead of a
// write-then-chmod, which would leave a window where the document is
// world-readable.
func (s *Sandboxes) WriteCodexCredential(ctx context.Context, sandbox work.SandboxID, file work.CredentialFile) error {
	if err := s.Write(ctx, sandbox, work.CodexAuthFile, file.Reveal(), credentialFileMode); err != nil {
		return fmt.Errorf("writing the sandbox's codex credential file: %w", err)
	}
	return nil
}
