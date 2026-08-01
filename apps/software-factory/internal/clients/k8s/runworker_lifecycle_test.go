package k8s

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

func validRunWorkerSecrets() work.RunWorkerSecretMaterial {
	return work.RunWorkerSecretMaterial{
		CodexCredential:      work.NewCredentialFile([]byte(`{"tokens":{"access_token":"codex-secret"}}`)),
		GitHubToken:          work.NewCredential("ghs_initial_secret"),
		GitHubLogin:          "www-software-factory-bot[bot]",
		GitHubExpiresAt:      time.Date(2026, 7, 31, 19, 0, 0, 0, time.UTC),
		CheckpointCapability: work.NewCredential("checkpoint-secret"),
	}
}

func mustRunWorkers(t *testing.T, cs *fake.Clientset) *RunWorkers {
	t.Helper()
	workers, err := newRunWorkers(cs, "software-factory", discardLogger(), testClock())
	if err != nil {
		t.Fatalf("newRunWorkers: %v", err)
	}
	return workers
}

func TestProvisionRunWorkerCreatesPodAndGenerationSecrets(t *testing.T) {
	cs := fake.NewSimpleClientset()
	workers := mustRunWorkers(t, cs)
	id, err := workers.Provision(context.Background(), validRunWorkerSpec(), validRunWorkerSecrets())
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if id != work.RunWorkerName(validRunWorkerSpec().Identity) {
		t.Errorf("ID = %q", id)
	}
	if _, err := cs.CoreV1().Pods("software-factory").Get(context.Background(), string(id), metav1.GetOptions{}); err != nil {
		t.Errorf("pod: %v", err)
	}
	for _, name := range runWorkerSecretNames(id) {
		if _, err := cs.CoreV1().Secrets("software-factory").Get(context.Background(), name, metav1.GetOptions{}); err != nil {
			t.Errorf("secret %s: %v", name, err)
		}
	}
}

func TestRotateGitHubCredentialReturnsOnlyRevisionAndExpiry(t *testing.T) {
	cs := fake.NewSimpleClientset()
	workers := mustRunWorkers(t, cs)
	id, err := workers.Provision(context.Background(), validRunWorkerSpec(), validRunWorkerSecrets())
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	expires := time.Date(2026, 7, 31, 19, 30, 0, 0, time.UTC)
	got, err := workers.RotateGitHubCredential(context.Background(), id, work.NewCredential("ghs_rotated_secret"), "bot[bot]", expires)
	if err != nil {
		t.Fatalf("RotateGitHubCredential: %v", err)
	}
	if got.Revision != "2" || !got.ExpiresAt.Equal(expires) {
		t.Errorf("safe result = %+v", got)
	}
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	if strings.Contains(string(raw), "ghs_") {
		t.Errorf("rotation result leaked token: %s", raw)
	}
	secret, err := cs.CoreV1().Secrets("software-factory").Get(context.Background(), runWorkerGitHubSecretName(id), metav1.GetOptions{})
	if err != nil {
		t.Fatalf("read rotated Secret: %v", err)
	}
	if string(secret.Data[runWorkerGitHubTokenKey]) != "ghs_rotated_secret" || string(secret.Data[runWorkerGitHubRevisionKey]) != "2" {
		t.Error("rotated Secret data did not advance")
	}
}

func TestDeleteRunWorkerRemovesPodAndAllGenerationSecrets(t *testing.T) {
	cs := fake.NewSimpleClientset()
	workers := mustRunWorkers(t, cs)
	id, err := workers.Provision(context.Background(), validRunWorkerSpec(), validRunWorkerSecrets())
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if err := workers.Delete(context.Background(), id); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := cs.CoreV1().Pods("software-factory").Get(context.Background(), string(id), metav1.GetOptions{}); err == nil {
		t.Error("pod still exists")
	}
	for _, name := range runWorkerSecretNames(id) {
		if _, err := cs.CoreV1().Secrets("software-factory").Get(context.Background(), name, metav1.GetOptions{}); err == nil {
			t.Errorf("secret %s still exists", name)
		}
	}
}
