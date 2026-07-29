package k8s

import (
	"archive/tar"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

func TestWriteCodexCredentialWritesTheDocumentToCodexAuthFileAtMode0600(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{{}}}
	s, _ := newTestSandboxes(t, str, runningPod())

	doc := []byte(`{"tokens":{"access_token":"secret-value"}}`)
	if err := s.WriteCodexCredential(context.Background(), testSandbox, work.NewCredentialFile(doc)); err != nil {
		t.Fatalf("WriteCodexCredential returned an unexpected error: %v", err)
	}

	entries := decodeTar(t, str.observed()[0].stdin)
	last := entries[len(entries)-1]
	if last.typeflag != tar.TypeReg {
		t.Fatalf("last entry typeflag = %q, want a regular file", last.typeflag)
	}
	if last.name != work.CodexAuthFile[1:] {
		// tar entries are stored relative (see tarStream), so the leading
		// slash of the absolute path is stripped.
		t.Errorf("wrote to %q, want %q", last.name, work.CodexAuthFile[1:])
	}
	if last.mode != 0o600 {
		t.Errorf("file mode = %#o, want 0600 — a credential file at any wider mode is #363", last.mode)
	}
	if last.body != string(doc) {
		t.Errorf("body = %q, want the document unchanged", last.body)
	}
}

func TestWriteCodexCredentialNeverPutsTheDocumentInAnErrorMessage(t *testing.T) {
	t.Parallel()

	str := &scriptedStreamer{answers: []answer{{err: errors.New("connection refused")}}}
	s, _ := newTestSandboxes(t, str, runningPod())

	doc := []byte(`{"tokens":{"access_token":"must-not-leak"}}`)
	err := s.WriteCodexCredential(context.Background(), testSandbox, work.NewCredentialFile(doc))
	if err == nil {
		t.Fatal("expected the underlying exec failure to surface")
	}
	if strings.Contains(err.Error(), "must-not-leak") {
		t.Fatalf("error %q leaked the credential document", err)
	}
}
