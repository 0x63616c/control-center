package k8s

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

const (
	runWorkerCodexSecretPrefix      = "run-worker-codex-"
	runWorkerGitHubSecretPrefix     = "run-worker-github-"
	runWorkerCheckpointSecretPrefix = "run-worker-checkpoint-"
	runWorkerCodexAuthKey           = "auth.json"
	runWorkerGitHubTokenKey         = "token"
	runWorkerGitHubLoginKey         = "login"
	runWorkerGitHubRevisionKey      = "revision"
	runWorkerGitHubExpiresAtKey     = "expires-at"
	runWorkerCheckpointKey          = "capability"
)

func runWorkerCodexSecretName(id work.RunWorkerID) string {
	return runWorkerCodexSecretPrefix + string(id)
}

func runWorkerGitHubSecretName(id work.RunWorkerID) string {
	return runWorkerGitHubSecretPrefix + string(id)
}

func runWorkerCheckpointSecretName(id work.RunWorkerID) string {
	return runWorkerCheckpointSecretPrefix + string(id)
}

func runWorkerSecretNames(id work.RunWorkerID) []string {
	return []string{runWorkerCodexSecretName(id), runWorkerGitHubSecretName(id), runWorkerCheckpointSecretName(id)}
}

// Provision creates one target worker generation and all of its file-only
// capabilities. It returns before Temporal's Session handshake proves ready.
func (r *RunWorkers) Provision(ctx context.Context, spec work.RunWorkerSpec, material work.RunWorkerSecretMaterial) (work.RunWorkerID, error) {
	pod, err := buildRunWorkerPod(spec, r.opts)
	if err != nil {
		return "", err
	}
	if err := validateRunWorkerSecretMaterial(material); err != nil {
		return "", err
	}
	id := work.RunWorkerID(pod.Name)
	labels := runWorkerLabels(spec)
	if err := r.putSecret(ctx, runWorkerCodexSecretName(id), labels, map[string][]byte{
		runWorkerCodexAuthKey: material.CodexCredential.Reveal(),
	}); err != nil {
		return "", err
	}
	if err := r.putSecret(ctx, runWorkerCheckpointSecretName(id), labels, map[string][]byte{
		runWorkerCheckpointKey: []byte(material.CheckpointCapability.Reveal()),
	}); err != nil {
		return "", err
	}
	if _, err := r.putGitHubSecret(ctx, id, labels, material.GitHubToken, material.GitHubLogin, material.GitHubExpiresAt); err != nil {
		return "", err
	}

	pods := r.cs.CoreV1().Pods(r.ns)
	if _, err := pods.Create(ctx, pod, metav1.CreateOptions{}); err != nil {
		if !apierrors.IsAlreadyExists(err) {
			return "", fmt.Errorf("creating Run Worker %s: %w", id, err)
		}
		existing, getErr := pods.Get(ctx, pod.Name, metav1.GetOptions{})
		if getErr != nil {
			return "", fmt.Errorf("reading existing Run Worker %s: %w", id, getErr)
		}
		if !runWorkerPodMatches(existing, pod) {
			return "", fmt.Errorf("existing Run Worker %s differs from its requested generation: %w", id, work.ErrPermanent)
		}
	}
	r.logger.InfoContext(ctx, "Run Worker provisioned", "run_worker", id, "run_id", spec.Identity.RunID, "generation", spec.Identity.Generation, "image", spec.Image)
	return id, nil
}

// RotateGitHubCredential atomically replaces the projected GitHub files and
// returns only the revision the Run Worker can observe plus its expiry.
func (r *RunWorkers) RotateGitHubCredential(ctx context.Context, id work.RunWorkerID, token work.Credential, login string, expiresAt time.Time) (work.RunWorkerCredentialRevision, error) {
	if strings.TrimSpace(token.Reveal()) == "" || strings.TrimSpace(login) == "" || expiresAt.IsZero() {
		return work.RunWorkerCredentialRevision{}, fmt.Errorf("rotating Run Worker GitHub credential requires token, login, and expiry: %w", work.ErrPermanent)
	}
	secret, err := r.cs.CoreV1().Secrets(r.ns).Get(ctx, runWorkerGitHubSecretName(id), metav1.GetOptions{})
	if err != nil {
		return work.RunWorkerCredentialRevision{}, fmt.Errorf("reading Run Worker %s GitHub Secret: %w", id, err)
	}
	result, err := r.updateGitHubSecret(ctx, secret, token, login, expiresAt)
	if err != nil {
		return work.RunWorkerCredentialRevision{}, err
	}
	r.logger.InfoContext(ctx, "Run Worker GitHub credential rotated", "run_worker", id, "revision", result.Revision, "expires_at", result.ExpiresAt)
	return result, nil
}

// Delete removes a target worker and every per-generation Secret. Absence is
// success so Temporal cleanup retries are idempotent.
func (r *RunWorkers) Delete(ctx context.Context, id work.RunWorkerID) error {
	if err := ignoreAbsent(r.cs.CoreV1().Pods(r.ns).Delete(ctx, string(id), metav1.DeleteOptions{})); err != nil {
		return fmt.Errorf("deleting Run Worker %s: %w", id, err)
	}
	for _, name := range runWorkerSecretNames(id) {
		if err := ignoreAbsent(r.cs.CoreV1().Secrets(r.ns).Delete(ctx, name, metav1.DeleteOptions{})); err != nil {
			return fmt.Errorf("deleting Run Worker %s Secret %s: %w", id, name, err)
		}
	}
	r.logger.InfoContext(ctx, "Run Worker deleted", "run_worker", id)
	return nil
}

func validateRunWorkerSecretMaterial(material work.RunWorkerSecretMaterial) error {
	if len(material.CodexCredential.Reveal()) == 0 || strings.TrimSpace(material.GitHubToken.Reveal()) == "" ||
		strings.TrimSpace(material.GitHubLogin) == "" || material.GitHubExpiresAt.IsZero() ||
		strings.TrimSpace(material.CheckpointCapability.Reveal()) == "" {
		return fmt.Errorf("run worker provisioning requires Codex, GitHub, and checkpoint file material: %w", work.ErrPermanent)
	}
	return nil
}

func (r *RunWorkers) putSecret(ctx context.Context, name string, labels map[string]string, data map[string][]byte) error {
	secrets := r.cs.CoreV1().Secrets(r.ns)
	want := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: name, Labels: labels}, Type: corev1.SecretTypeOpaque, Data: data}
	if _, err := secrets.Create(ctx, want, metav1.CreateOptions{}); err == nil {
		return nil
	} else if !apierrors.IsAlreadyExists(err) {
		return fmt.Errorf("creating Run Worker Secret %s: %w", name, err)
	}
	existing, err := secrets.Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("reading Run Worker Secret %s: %w", name, err)
	}
	existing.Labels = labels
	existing.Data = data
	if _, err := secrets.Update(ctx, existing, metav1.UpdateOptions{}); err != nil {
		return fmt.Errorf("updating Run Worker Secret %s: %w", name, err)
	}
	return nil
}

func (r *RunWorkers) putGitHubSecret(ctx context.Context, id work.RunWorkerID, labels map[string]string, token work.Credential, login string, expiresAt time.Time) (work.RunWorkerCredentialRevision, error) {
	secrets := r.cs.CoreV1().Secrets(r.ns)
	want := githubSecret(runWorkerGitHubSecretName(id), labels, token, login, expiresAt, 1)
	if _, err := secrets.Create(ctx, want, metav1.CreateOptions{}); err == nil {
		return work.RunWorkerCredentialRevision{Revision: "1", ExpiresAt: expiresAt.UTC()}, nil
	} else if !apierrors.IsAlreadyExists(err) {
		return work.RunWorkerCredentialRevision{}, fmt.Errorf("creating Run Worker GitHub Secret: %w", err)
	}
	existing, err := secrets.Get(ctx, want.Name, metav1.GetOptions{})
	if err != nil {
		return work.RunWorkerCredentialRevision{}, fmt.Errorf("reading Run Worker GitHub Secret: %w", err)
	}
	existing.Labels = labels
	return r.updateGitHubSecret(ctx, existing, token, login, expiresAt)
}

func (r *RunWorkers) updateGitHubSecret(ctx context.Context, secret *corev1.Secret, token work.Credential, login string, expiresAt time.Time) (work.RunWorkerCredentialRevision, error) {
	current, err := strconv.Atoi(string(secret.Data[runWorkerGitHubRevisionKey]))
	if err != nil || current < 1 {
		return work.RunWorkerCredentialRevision{}, fmt.Errorf("run worker GitHub Secret %s has invalid revision metadata: %w", secret.Name, work.ErrPermanent)
	}
	revision := current + 1
	secret.Data = githubSecretData(token, login, expiresAt, revision)
	if _, err := r.cs.CoreV1().Secrets(r.ns).Update(ctx, secret, metav1.UpdateOptions{}); err != nil {
		return work.RunWorkerCredentialRevision{}, fmt.Errorf("updating Run Worker GitHub Secret %s: %w", secret.Name, err)
	}
	return work.RunWorkerCredentialRevision{Revision: strconv.Itoa(revision), ExpiresAt: expiresAt.UTC()}, nil
}

func githubSecret(name string, labels map[string]string, token work.Credential, login string, expiresAt time.Time, revision int) *corev1.Secret {
	return &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: name, Labels: labels}, Type: corev1.SecretTypeOpaque, Data: githubSecretData(token, login, expiresAt, revision)}
}

func githubSecretData(token work.Credential, login string, expiresAt time.Time, revision int) map[string][]byte {
	return map[string][]byte{
		runWorkerGitHubTokenKey:     []byte(token.Reveal()),
		runWorkerGitHubLoginKey:     []byte(login),
		runWorkerGitHubRevisionKey:  []byte(strconv.Itoa(revision)),
		runWorkerGitHubExpiresAtKey: []byte(expiresAt.UTC().Format(time.RFC3339Nano)),
	}
}

func runWorkerPodMatches(got, want *corev1.Pod) bool {
	if len(got.Spec.Containers) != 1 || len(want.Spec.Containers) != 1 {
		return false
	}
	g, w := got.Spec.Containers[0], want.Spec.Containers[0]
	return g.Image == w.Image && strings.Join(g.Command, "\x00") == strings.Join(w.Command, "\x00") &&
		strings.Join(renderEnv(g.Env), "\x00") == strings.Join(renderEnv(w.Env), "\x00")
}

func renderEnv(env []corev1.EnvVar) []string {
	out := make([]string, 0, len(env))
	for _, item := range env {
		out = append(out, item.Name+"="+item.Value)
	}
	return out
}
