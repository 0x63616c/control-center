package activities

import (
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codexauth"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/github"
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

// TestTheCodexAuthSourceSatisfiesTheTokenSourceSeam pins the other half of the
// credential seam, for the same reason and from the same side.
//
// Until something in cmd/ constructs a codexauth.Source, nothing else binds
// these two types together, so renaming SandboxCredentialFile on either side
// alone leaves `go build ./...` and `go vet ./...` green and the two halves
// silently drifted. This is the assertion that turns that into a failure.
func TestTheCodexAuthSourceSatisfiesTheTokenSourceSeam(t *testing.T) {
	t.Parallel()

	var source *codexauth.Source
	var _ TokenSource = source
}
