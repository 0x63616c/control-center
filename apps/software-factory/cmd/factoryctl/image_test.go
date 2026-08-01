package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPolicyCommandPreservesMachineReadableNonReadyReport(t *testing.T) {
	t.Parallel()
	input := `[{"name":"approval","enforcement":"active","bypass_actors":[],"rules":[{"type":"pull_request","parameters":{"required_approving_review_count":1}}]}]`
	var stdout bytes.Buffer
	err := run(context.Background(), []string{"verify-github-policy", "--app-id", "42"}, bytes.NewBufferString(input), &stdout, &bytes.Buffer{})
	if err == nil {
		t.Fatal("policy command accepted a non-ready policy")
	}
	var report struct {
		Ready bool `json:"ready"`
	}
	if decodeErr := json.Unmarshal(stdout.Bytes(), &report); decodeErr != nil {
		t.Fatalf("stdout = %q, want a JSON report: %v", stdout.String(), decodeErr)
	}
	if report.Ready {
		t.Fatalf("report = %+v, want not ready", report)
	}
}

func TestWorkerImageContainsFactoryctl(t *testing.T) {
	dockerfile := filepath.Join("..", "..", "images", "worker", "Dockerfile")
	contents, err := os.ReadFile(dockerfile)
	if err != nil {
		t.Fatalf("read %s: %v", dockerfile, err)
	}
	text := string(contents)
	for _, want := range []string{
		"go build -trimpath -ldflags=\"-s -w\" -o /out/factoryctl ./cmd/factoryctl",
		"COPY --from=build /out/factoryctl /usr/local/bin/factoryctl",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("worker Dockerfile does not contain %q", want)
		}
	}
}
