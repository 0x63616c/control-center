package activities

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"go.temporal.io/sdk/temporal"
)

const (
	repositoryEffectClone = "clone"
	repositoryEffectCI    = "await_ci"
	repositoryEffectFind  = "find_pull_request"
	repositoryEffectSync  = "sync_pull_request"
	repositoryEffectReady = "mark_pull_request_ready"
	repositoryEffectMerge = "merge_pull_request"
)

// RepositoryStep is the complete non-secret Git/PR recovery position carried
// between repository-affine Steps. StepOrdinal identifies the result this
// activity must durably complete before acknowledging success.
type RepositoryStep struct {
	StepOrdinal       int
	Branch            string
	PushedHead        string
	ObservedBase      string
	PullRequestNumber int
	PullRequestNodeID string
}

type repositoryEffectEnvelope struct {
	Kind   string          `json:"kind"`
	Result json.RawMessage `json:"result"`
}

// CloneTargetRepositoryInput identifies the repository Step and source to
// restore on this Run Worker generation.
type CloneTargetRepositoryInput struct {
	Step     RepositoryStep
	CloneURL string
}

// CloneTargetRepositoryOutput records the exact restored candidate head.
type CloneTargetRepositoryOutput struct{ HeadSHA string }

// CloneTargetRepository is the first Session-bound operation. It restores the
// local checkout, then completes its infrastructure Step before returning.
func (a *RunWorkerActivities) CloneTargetRepository(ctx context.Context, in CloneTargetRepositoryInput) (CloneTargetRepositoryOutput, error) {
	cp, raw, found, err := a.loadRepositoryResult(ctx, in.Step, repositoryEffectClone)
	if err != nil {
		return CloneTargetRepositoryOutput{}, fmt.Errorf("loading target repository clone effect: %w", err)
	}
	head, err := a.deps.Repository.Prepare(ctx, in.CloneURL, in.Step.Branch)
	if err != nil {
		return CloneTargetRepositoryOutput{}, fail(ctx, "preparing the target repository", err)
	}
	if found {
		// A repository checkpoint survives replacement; this filesystem does
		// not. Always restore locally, but return the exact durable Step result
		// and never checkpoint/publish that completed effect a second time.
		return decodeRepositoryResult[CloneTargetRepositoryOutput](raw)
	}
	out := CloneTargetRepositoryOutput{HeadSHA: head}
	position := in.Step
	position.PushedHead = head
	if err := a.checkpointRepositoryResult(ctx, cp, position, repositoryEffectClone, out); err != nil {
		return CloneTargetRepositoryOutput{}, fmt.Errorf("checkpointing target repository clone effect: %w", err)
	}
	return out, nil
}

// TargetAwaitCIInput binds a CI observation to one durable repository Step.
type TargetAwaitCIInput struct {
	Step RepositoryStep
	CI   AwaitCIInput
}

// TargetAwaitCI observes required checks for the exact durable candidate head.
func (a *RunWorkerActivities) TargetAwaitCI(ctx context.Context, in TargetAwaitCIInput) (AwaitCIOutput, error) {
	cp, raw, found, err := a.loadRepositoryResult(ctx, in.Step, repositoryEffectCI)
	if err != nil {
		return AwaitCIOutput{}, fmt.Errorf("loading target CI effect: %w", err)
	}
	if found {
		return decodeRepositoryResult[AwaitCIOutput](raw)
	}
	if err := validateAwaitCIInput(in.CI); err != nil {
		return AwaitCIOutput{}, fail(ctx, "awaiting target CI", err)
	}
	if in.Step.PushedHead != in.CI.CommitSHA {
		return AwaitCIOutput{}, fail(ctx, "awaiting target CI", fmt.Errorf("candidate SHA does not match the repository position: %w", work.ErrPermanent))
	}
	checks, err := a.deps.GitHub.ChecksForCommit(ctx, in.CI.CommitSHA, in.CI.RequiredChecks)
	if err != nil {
		return AwaitCIOutput{}, fail(ctx, fmt.Sprintf("awaiting target CI for commit %s", in.CI.CommitSHA), err)
	}
	green, failures := reduceRequiredChecks(checks, in.CI.RequiredChecks)
	if !green && failures == nil {
		return AwaitCIOutput{}, temporal.NewApplicationErrorWithOptions(
			fmt.Sprintf("target CI for commit %s has not concluded for every required check", in.CI.CommitSHA),
			ErrTypeCINotConcluded, temporal.ApplicationErrorOptions{NextRetryDelay: awaitCIRetryDelay})
	}
	out := AwaitCIOutput{CommitSHA: in.CI.CommitSHA, Green: green, RedFailures: failures}
	if err := a.checkpointRepositoryResult(ctx, cp, in.Step, repositoryEffectCI, out); err != nil {
		return AwaitCIOutput{}, fmt.Errorf("checkpointing target CI effect: %w", err)
	}
	return out, nil
}

// TargetFindPullRequestInput binds PR discovery to one repository Step.
type TargetFindPullRequestInput struct{ Step RepositoryStep }

// TargetFindPullRequest discovers the PR associated with the durable branch.
func (a *RunWorkerActivities) TargetFindPullRequest(ctx context.Context, in TargetFindPullRequestInput) (FindPullRequestOutput, error) {
	cp, raw, found, err := a.loadRepositoryResult(ctx, in.Step, repositoryEffectFind)
	if err != nil {
		return FindPullRequestOutput{}, fmt.Errorf("loading target pull request discovery effect: %w", err)
	}
	if found {
		return decodeRepositoryResult[FindPullRequestOutput](raw)
	}
	pr, exists, err := a.deps.GitHub.PullRequestForBranch(ctx, in.Step.Branch)
	if err != nil {
		return FindPullRequestOutput{}, fail(ctx, "finding the target pull request", err)
	}
	out := FindPullRequestOutput{PullRequest: pr, Found: exists}
	position := in.Step
	if exists {
		position.PullRequestNumber, position.PullRequestNodeID = pr.Number, pr.NodeID
	}
	if err := a.checkpointRepositoryResult(ctx, cp, position, repositoryEffectFind, out); err != nil {
		return FindPullRequestOutput{}, fmt.Errorf("checkpointing target pull request discovery effect: %w", err)
	}
	return out, nil
}

// TargetSyncPullRequestInput carries the durable Step and desired PR content.
type TargetSyncPullRequestInput struct {
	Step     RepositoryStep
	Title    string
	Body     string
	Existing *work.PullRequest
}

// TargetSyncPullRequest opens or updates the branch PR and checkpoints it.
func (a *RunWorkerActivities) TargetSyncPullRequest(ctx context.Context, in TargetSyncPullRequestInput) (work.PullRequest, error) {
	// Synchronization discovers the authoritative pushed head from GitHub. A
	// retry begins from the preceding repository position, so its input still
	// carries that old head while the completed checkpoint carries the newly
	// observed one.
	recoveryStep := in.Step
	recoveryStep.PushedHead = ""
	cp, raw, found, err := a.loadRepositoryResult(ctx, recoveryStep, repositoryEffectSync)
	if err != nil {
		return work.PullRequest{}, fmt.Errorf("loading target pull request sync effect: %w", err)
	}
	if found {
		return decodeRepositoryResult[work.PullRequest](raw)
	}
	if strings.TrimSpace(in.Title) == "" {
		return work.PullRequest{}, fail(ctx, "synchronizing the target pull request", fmt.Errorf("title is required: %w", work.ErrPermanent))
	}
	pr, err := a.deps.GitHub.OpenOrUpdatePullRequest(ctx, in.Step.Branch, in.Title, in.Body, in.Existing)
	if err != nil {
		return work.PullRequest{}, fail(ctx, "synchronizing the target pull request", err)
	}
	position := in.Step
	position.PushedHead = pr.HeadSHA
	position.PullRequestNumber, position.PullRequestNodeID = pr.Number, pr.NodeID
	if err := a.checkpointRepositoryResult(ctx, cp, position, repositoryEffectSync, pr); err != nil {
		return work.PullRequest{}, fmt.Errorf("checkpointing target pull request sync effect: %w", err)
	}
	return pr, nil
}

// TargetMarkPullRequestReadyInput identifies the PR Step to make reviewable.
type TargetMarkPullRequestReadyInput struct{ Step RepositoryStep }

// TargetMarkPullRequestReady removes draft status and checkpoints the effect.
func (a *RunWorkerActivities) TargetMarkPullRequestReady(ctx context.Context, in TargetMarkPullRequestReadyInput) error {
	cp, _, found, err := a.loadRepositoryResult(ctx, in.Step, repositoryEffectReady)
	if err != nil {
		return fmt.Errorf("loading target pull request ready effect: %w", err)
	}
	if found {
		return nil
	}
	if strings.TrimSpace(in.Step.PullRequestNodeID) == "" {
		return fail(ctx, "marking the target pull request ready", fmt.Errorf("pull request node ID is empty: %w", work.ErrPermanent))
	}
	if err := a.deps.GitHub.MarkPullRequestReadyForReview(ctx, in.Step.PullRequestNodeID); err != nil {
		return fail(ctx, "marking the target pull request ready", err)
	}
	return a.checkpointRepositoryResult(ctx, cp, in.Step, repositoryEffectReady, struct{}{})
}

// TargetMergePullRequestInput binds merge to the exact reviewed candidate.
type TargetMergePullRequestInput struct {
	Step            RepositoryStep
	ExpectedHeadSHA string
}

// TargetMergePullRequest requests an exact-head merge and checkpoints GitHub's result.
func (a *RunWorkerActivities) TargetMergePullRequest(ctx context.Context, in TargetMergePullRequestInput) (work.PullRequestMergeResult, error) {
	cp, raw, found, err := a.loadRepositoryResult(ctx, in.Step, repositoryEffectMerge)
	if err != nil {
		return work.PullRequestMergeResult{}, fmt.Errorf("loading target pull request merge effect: %w", err)
	}
	if found {
		return decodeRepositoryResult[work.PullRequestMergeResult](raw)
	}
	if in.Step.PullRequestNumber <= 0 || strings.TrimSpace(in.ExpectedHeadSHA) == "" || in.ExpectedHeadSHA != in.Step.PushedHead {
		return work.PullRequestMergeResult{}, fail(ctx, "merging the target pull request", fmt.Errorf("pull request and exact current head SHA are required: %w", work.ErrPermanent))
	}
	result, err := a.deps.GitHub.MergePullRequest(ctx, in.Step.PullRequestNumber, in.ExpectedHeadSHA)
	if err != nil {
		return work.PullRequestMergeResult{}, fail(ctx, "merging the target pull request", err)
	}
	if err := a.checkpointRepositoryResult(ctx, cp, in.Step, repositoryEffectMerge, result); err != nil {
		return work.PullRequestMergeResult{}, fmt.Errorf("checkpointing target pull request merge effect: %w", err)
	}
	return result, nil
}

func (a *RunWorkerActivities) loadRepositoryResult(ctx context.Context, requested RepositoryStep, kind string) (RepositoryCheckpoint, json.RawMessage, bool, error) {
	if requested.StepOrdinal <= 0 || strings.TrimSpace(requested.Branch) == "" {
		return nil, nil, false, fail(ctx, "validating repository Step", fmt.Errorf("positive ordinal and branch are required: %w", work.ErrPermanent))
	}
	cp, err := a.deps.RepositoryCheckpoints(a.deps.Identity)
	if err != nil {
		return nil, nil, false, fail(ctx, "opening repository checkpoint", err)
	}
	stored, found, err := cp.Load(ctx)
	if err != nil {
		return nil, nil, false, fail(ctx, "loading repository checkpoint", err)
	}
	if !found || stored.StepOrdinal < requested.StepOrdinal {
		return cp, nil, false, nil
	}
	if stored.StepOrdinal > requested.StepOrdinal || !repositoryPositionMatches(stored, requested) {
		return nil, nil, false, fail(ctx, "reconciling repository checkpoint", fmt.Errorf("checkpoint does not belong to the requested Step/effect: %w", work.ErrPermanent))
	}
	var envelope repositoryEffectEnvelope
	if err := json.Unmarshal(stored.StepResult, &envelope); err != nil || envelope.Kind != kind || len(envelope.Result) == 0 {
		return nil, nil, false, fail(ctx, "reconciling repository checkpoint", fmt.Errorf("durable result does not encode %s: %w", kind, work.ErrPermanent))
	}
	return cp, envelope.Result, true, nil
}

func (a *RunWorkerActivities) checkpointRepositoryResult(ctx context.Context, cp RepositoryCheckpoint, position RepositoryStep, kind string, result any) error {
	raw, err := json.Marshal(result)
	if err != nil {
		return fail(ctx, "encoding repository Step result", err)
	}
	envelope, err := json.Marshal(repositoryEffectEnvelope{Kind: kind, Result: raw})
	if err != nil {
		return fail(ctx, "encoding repository checkpoint", err)
	}
	_, err = cp.Checkpoint(ctx, store.GitCheckpointInput{GitCheckpoint: store.GitCheckpoint{
		RunID: a.deps.Identity.RunID, StepOrdinal: position.StepOrdinal, Branch: position.Branch,
		PushedHead: position.PushedHead, ObservedBase: position.ObservedBase,
		PullRequestNumber: position.PullRequestNumber, PullRequestNodeID: position.PullRequestNodeID, StepResult: envelope,
	}, CompletedAt: a.deps.Clock.Now().UTC()})
	if err != nil {
		return fail(ctx, fmt.Sprintf("checkpointing repository Step %d", position.StepOrdinal), err)
	}
	return nil
}

func repositoryPositionMatches(stored store.GitCheckpoint, requested RepositoryStep) bool {
	if stored.Branch != requested.Branch {
		return false
	}
	return (requested.PushedHead == "" || stored.PushedHead == requested.PushedHead) &&
		(requested.ObservedBase == "" || stored.ObservedBase == requested.ObservedBase) &&
		(requested.PullRequestNumber == 0 || stored.PullRequestNumber == requested.PullRequestNumber) &&
		(requested.PullRequestNodeID == "" || stored.PullRequestNodeID == requested.PullRequestNodeID)
}

func decodeRepositoryResult[T any](raw json.RawMessage) (T, error) {
	var result T
	if err := json.Unmarshal(raw, &result); err != nil {
		return result, fmt.Errorf("decoding durable repository activity result: %w", err)
	}
	return result, nil
}
