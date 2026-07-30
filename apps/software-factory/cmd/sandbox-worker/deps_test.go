package main

import (
	"context"
	"crypto/rand"
	"io"
	"log/slog"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/prompts"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// fakeTranscriptSink stands in for activities.TranscriptSink so this test
// never opens a real file — the wiring is what is under test, not behaviour.
type fakeTranscriptSink struct{}

func (fakeTranscriptSink) Open(context.Context, work.StageKey) (io.WriteCloser, error) {
	panic("not called by this test")
}

// TestBuildSandboxDepsSatisfiesActivitiesNewSandboxSide is
// TestBuildDepsSatisfiesActivitiesNew's counterpart for this composition
// root: it hands buildSandboxDeps a real renderer and a real logger, and
// asserts the activities.SandboxDeps that comes out is one
// activities.NewSandboxSide actually accepts. A future field added to
// SandboxDeps that this file forgets to populate fails here instead of in a
// pod's crash loop.
func TestBuildSandboxDepsSatisfiesActivitiesNewSandboxSide(t *testing.T) {
	t.Parallel()

	renderer, err := prompts.New(rand.Reader)
	if err != nil {
		t.Fatalf("building the prompt renderer: %v", err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	deps := buildSandboxDeps(fakeTranscriptSink{}, renderer, logger)
	if _, err := activities.NewSandboxSide(deps); err != nil {
		t.Fatalf("activities.NewSandboxSide(buildSandboxDeps(...)) = %v, want a Deps it accepts", err)
	}
}
