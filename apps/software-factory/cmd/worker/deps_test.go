package main

import (
	"crypto/rand"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codexauth"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/github"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/k8s"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock/clocktest"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/config"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/prompts"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/telemetry"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/transcripts"
)

// TestBuildDepsSatisfiesActivitiesNew is the regression test #395's own
// receipt promised: it hands buildDeps a stand-in for every client
// newActivities constructs and asserts the activities.Deps that comes out is
// one activities.New actually accepts.
//
// It exists because activities.New's validation is enumerated — every field
// checked by name — and buildDeps's assembly was not: a seam that added a
// field to activities.Deps (Repo, for CloneRepo, #383) compiled clean and
// passed every existing test, because nothing exercised buildDeps's output
// against New's requirements. The gap was only visible on the live cluster,
// as a crash loop. This test calls the real buildDeps and the real
// activities.New, so a future field added to Deps gains this coverage
// automatically the day it is added, with no second field list to keep in
// sync by hand.
//
// Every client is a nil-typed concrete pointer rather than a hand-rolled
// fake: each type already satisfies its activities interface (pinned in
// internal/activities/deps_test.go for GitHub, TokenSource, RepoCloner and
// CredentialWriter), and a nil pointer wrapped in an interface is a non-nil
// interface value — exactly what activities.New's presence checks look for.
// None of their methods are called here; this test is about wiring, not
// behaviour.
func TestBuildDepsSatisfiesActivitiesNew(t *testing.T) {
	t.Parallel()

	cfg := config.Worker{
		SandboxNamespace:   "software-factory",
		SandboxImage:       "ghcr.io/0x63616c/software-factory-sandbox@sha256:deadbeef",
		SandboxCPULimit:    "2",
		SandboxMemoryLimit: "4Gi",
		TemporalUIBaseURL:  "https://temporal.worldwidewebb.co",
		TemporalNamespace:  "software-factory",
		TranscriptsRoot:    "/transcripts",
	}
	ghCfg := config.GitHub{Owner: "0x63616c", Repo: "world-wide-webb"}

	renderer, err := prompts.New(rand.Reader)
	if err != nil {
		t.Fatalf("building the prompt renderer: %v", err)
	}

	deps := buildDeps(
		cfg,
		ghCfg,
		(*github.Client)(nil),
		(*k8s.Sandboxes)(nil),
		(*transcripts.Sink)(nil),
		renderer,
		telemetry.NewMetrics(prometheus.NewRegistry()),
		nil, // client.Client: runs.New only stores it, it is never dialled here
		(*codexauth.Source)(nil),
		clocktest.NewFake(time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)),
		discardLogger(),
	)

	if _, err := activities.New(deps); err != nil {
		t.Fatalf("buildDeps produced a Deps activities.New refuses to construct from: %v\n"+
			"this is exactly #395's failure mode: a field added to activities.Deps that "+
			"buildDeps never populates crashes the live worker on boot, loudly, in production",
			err)
	}
}
