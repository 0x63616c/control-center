package activities

import (
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/github"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/k8s"
)

// TestTheGitHubClientSatisfiesTheGitHubSeam pins the two halves together from
// the consumer's side, which is the only side that may know about both.
//
// It is a test rather than a `var _ GitHub = ...` in deps.go because that
// declaration would make this package import a client at build time, inverting
// the direction the doc comment above GitHub describes: clients return concrete
// types and know nothing about these declarations.
func TestTheGitHubClientSatisfiesTheGitHubSeam(t *testing.T) {
	t.Parallel()

	var client *github.Client
	var _ GitHub = client
}

// TestTheSandboxesClientSatisfiesTheRepoClonerSeam pins CloneRepo's signature
// against its one implementation, for the same reason the two pins above do:
// nothing else in this service binds RepoCloner to *k8s.Sandboxes, so a
// signature drifting on either side would otherwise leave `go build ./...`
// green while the composition root failed to wire them together.
func TestTheSandboxesClientSatisfiesTheRepoClonerSeam(t *testing.T) {
	t.Parallel()

	var sandboxes *k8s.Sandboxes
	var _ RepoCloner = sandboxes
}
