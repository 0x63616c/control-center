package github

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	gh "github.com/google/go-github/v78/github"
)

// ChecksForRef returns every check run GitHub has recorded against ref — a
// branch name, in this service's only caller — as one snapshot.
//
// It takes no view on whether the checks it returns have concluded or
// passed: Activities.ObserveCI is what polls this repeatedly, waiting for a
// concluded result or its own bound, and reduces the snapshot into
// concluded/green/red for the implement/review loop's progress-detection
// rules. The client does not poll: it obtains one check-run snapshot and the
// annotations needed to identify its failed runs. Polling belongs to the
// activity, which owns the wait and the bound on it.
func (c *Client) ChecksForRef(ctx context.Context, ref string) ([]work.CheckRun, error) {
	op := fmt.Sprintf("listing check runs for %s", ref)

	opts := &gh.ListCheckRunsOptions{ListOptions: gh.ListOptions{PerPage: perPage}}

	var runs []work.CheckRun
	for {
		result, resp, err := c.api.Checks.ListCheckRunsForRef(ctx, c.owner, c.repo, ref, opts)
		if err != nil {
			return nil, classify(ctx, op, err)
		}
		for _, run := range result.CheckRuns {
			check := work.CheckRun{
				Name:       run.GetName(),
				Completed:  run.GetStatus() == "completed",
				Conclusion: run.GetConclusion(),
			}
			if check.Completed && !check.Green() {
				fingerprint, err := c.checkFailureFingerprint(ctx, run)
				if err != nil {
					return nil, err
				}
				check.FailureFingerprint = fingerprint
			}
			runs = append(runs, check)
		}
		if resp.NextPage == 0 {
			return runs, nil
		}
		opts.Page = resp.NextPage
	}
}

// checkFailureFingerprint reduces one failed check's output to a stable,
// opaque identity. The workflow persists only the digest, not CI text or
// annotations, which may be large and attacker-controlled.
func (c *Client) checkFailureFingerprint(ctx context.Context, run *gh.CheckRun) (string, error) {
	const op = "reading failed check details"

	if run.GetID() == 0 {
		return "", fmt.Errorf("%s: github returned failed check %q with no id", op, run.GetName())
	}

	annotations, err := c.checkRunAnnotations(ctx, run.GetID())
	if err != nil {
		return "", err
	}

	detail := checkFailureDetail{
		Conclusion:  run.GetConclusion(),
		Title:       run.GetOutput().GetTitle(),
		Summary:     run.GetOutput().GetSummary(),
		Text:        run.GetOutput().GetText(),
		Annotations: make([]checkAnnotationDetail, 0, len(annotations)),
	}
	for _, annotation := range annotations {
		candidate := checkAnnotationDetail{
			Path:            annotation.GetPath(),
			StartLine:       annotation.GetStartLine(),
			EndLine:         annotation.GetEndLine(),
			StartColumn:     annotation.GetStartColumn(),
			EndColumn:       annotation.GetEndColumn(),
			AnnotationLevel: annotation.GetAnnotationLevel(),
			Title:           annotation.GetTitle(),
			Message:         annotation.GetMessage(),
			RawDetails:      annotation.GetRawDetails(),
		}
		if genericGitHubActionsAnnotation(candidate) {
			continue
		}
		detail.Annotations = append(detail.Annotations, candidate)
	}
	if !detail.hasEvidence() {
		// GitHub Actions' generic exit-code annotation says a job failed but
		// not which assertion or test failed. Treating it as an identity would
		// turn a different failure in the same job into a false stagnation.
		return "", nil
	}
	sort.Slice(detail.Annotations, func(i, j int) bool {
		return annotationKey(detail.Annotations[i]) < annotationKey(detail.Annotations[j])
	})

	encoded, err := json.Marshal(detail)
	if err != nil {
		return "", fmt.Errorf("%s: serializing check %q details: %w", op, run.GetName(), err)
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

// checkRunAnnotations returns every annotation for a failed check or no
// snapshot at all. A partial failure fingerprint could falsely look like a
// changed failure on the next turn.
func (c *Client) checkRunAnnotations(ctx context.Context, checkRunID int64) ([]*gh.CheckRunAnnotation, error) {
	op := fmt.Sprintf("listing annotations for check run %d", checkRunID)
	opts := &gh.ListOptions{PerPage: perPage}

	var annotations []*gh.CheckRunAnnotation
	for {
		page, resp, err := c.api.Checks.ListCheckRunAnnotations(ctx, c.owner, c.repo, checkRunID, opts)
		if err != nil {
			return nil, classify(ctx, op, err)
		}
		annotations = append(annotations, page...)
		if resp.NextPage == 0 {
			return annotations, nil
		}
		opts.Page = resp.NextPage
	}
}

type checkFailureDetail struct {
	Conclusion  string                  `json:"conclusion"`
	Title       string                  `json:"title"`
	Summary     string                  `json:"summary"`
	Text        string                  `json:"text"`
	Annotations []checkAnnotationDetail `json:"annotations"`
}

func (d checkFailureDetail) hasEvidence() bool {
	return d.Title != "" || d.Summary != "" || d.Text != "" || len(d.Annotations) > 0
}

type checkAnnotationDetail struct {
	Path            string `json:"path"`
	StartLine       int    `json:"start_line"`
	EndLine         int    `json:"end_line"`
	StartColumn     int    `json:"start_column"`
	EndColumn       int    `json:"end_column"`
	AnnotationLevel string `json:"annotation_level"`
	Title           string `json:"title"`
	Message         string `json:"message"`
	RawDetails      string `json:"raw_details"`
}

// genericGitHubActionsAnnotation filters the workflow runner's stock exit
// annotation. It does not identify the failed command, unlike an annotation
// with a title, raw details, or a more specific message.
func genericGitHubActionsAnnotation(annotation checkAnnotationDetail) bool {
	return annotation.Title == "" && annotation.RawDetails == "" &&
		annotation.Message == "Process completed with exit code 1."
}

func annotationKey(annotation checkAnnotationDetail) string {
	return fmt.Sprintf("%q:%d:%d:%d:%d:%q:%q:%q:%q",
		annotation.Path,
		annotation.StartLine,
		annotation.EndLine,
		annotation.StartColumn,
		annotation.EndColumn,
		annotation.AnnotationLevel,
		annotation.Title,
		annotation.Message,
		annotation.RawDetails,
	)
}
