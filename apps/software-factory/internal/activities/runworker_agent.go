package activities

import (
	"context"
	"fmt"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// TargetRepository prepares the Run Worker's generation-local checkout.
type TargetRepository interface {
	Prepare(context.Context, string, string) (string, error)
	PrepareFromCommit(context.Context, string, string, string) (string, error)
}

// TargetGitHub is the repository-scoped external surface hosted by the Run
// Worker. Its implementation reads the renewable projected token per request.
type TargetGitHub interface {
	PullRequestForBranch(context.Context, string) (work.PullRequest, bool, error)
	OpenOrUpdatePullRequest(context.Context, string, string, string, *work.PullRequest) (work.PullRequest, error)
	MarkPullRequestReadyForReview(context.Context, string) error
	MergePullRequest(context.Context, int, string) (work.PullRequestMergeResult, error)
	ChecksForCommit(context.Context, string, []string) ([]work.CheckRun, error)
	RetirePullRequest(context.Context, int) (work.PullRequestRetirement, error)
}

// RepositoryCheckpoint is the generation-scoped recovery boundary for
// repository-affine Steps. Agent conversations and tool idempotency are owned
// by AgentWorkflow's blob-backed primitives instead of a provider thread.
type RepositoryCheckpoint interface {
	Load(context.Context) (store.GitCheckpoint, bool, error)
	Checkpoint(context.Context, store.GitCheckpointInput) (store.GitCheckpoint, error)
	CheckpointEffect(context.Context, store.GitCheckpointInput) (store.GitCheckpoint, error)
}

// RunWorkerDeps are the narrow dependencies of repository-affine activities.
// Typed agent tools are composed and registered separately at cmd/run-worker.
type RunWorkerDeps struct {
	Clock                 interface{ Now() time.Time }
	Repository            TargetRepository
	GitHub                TargetGitHub
	Identity              work.RunWorkerIdentity
	RepositoryCheckpoints func(work.RunWorkerIdentity) (RepositoryCheckpoint, error)
}

// RunWorkerActivities are repository-affine target activities. Agent tool
// execution is deliberately registered as the separately named agent.tool
// activity so AgentWorkflow can route it to this generation's private queue.
type RunWorkerActivities struct{ deps RunWorkerDeps }

// NewRunWorkerActivities validates the repository-affine activity set once.
func NewRunWorkerActivities(deps RunWorkerDeps) (*RunWorkerActivities, error) {
	if deps.Clock == nil || deps.Repository == nil || deps.GitHub == nil || deps.RepositoryCheckpoints == nil {
		return nil, fmt.Errorf("run worker activities require clock, repository, GitHub, and repository checkpoints")
	}
	if err := deps.Identity.Validate(); err != nil {
		return nil, fmt.Errorf("run worker activities require a valid identity: %w", err)
	}
	return &RunWorkerActivities{deps: deps}, nil
}
