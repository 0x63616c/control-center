package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureCodexHomeLinksToProjectedCredentialFile(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home")
	auth := filepath.Join(home, "auth.json")
	projected := filepath.Join(root, "projected", "auth.json")
	if err := os.MkdirAll(filepath.Dir(projected), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(projected, []byte("credential"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ensureCodexHome(home, auth, projected); err != nil {
		t.Fatalf("ensureCodexHome: %v", err)
	}
	target, err := os.Readlink(auth)
	if err != nil {
		t.Fatalf("Readlink: %v", err)
	}
	if target != projected {
		t.Errorf("auth link = %q, want %q", target, projected)
	}
}

func TestRunWorkerRegistersActivitiesButNoWorkflow(t *testing.T) {
	raw, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	for _, registration := range []string{"RegisterActivity(acts.RunPlan)", "RegisterActivity(acts.RunImplement)", "RegisterActivity(acts.RunReview)"} {
		if !strings.Contains(source, registration) {
			t.Errorf("main.go does not contain %s", registration)
		}
	}
	if strings.Contains(source, "RegisterWorkflow") {
		t.Error("Run Worker registers workflow code; workflow tasks belong to the main worker")
	}
}

func TestRunWorkerHasNoKubernetesClientDependency(t *testing.T) {
	raw, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"internal/clients/k8s", "NewInCluster", "pods/exec"} {
		if strings.Contains(string(raw), forbidden) {
			t.Errorf("main.go contains forbidden target runtime dependency %q", forbidden)
		}
	}
}
