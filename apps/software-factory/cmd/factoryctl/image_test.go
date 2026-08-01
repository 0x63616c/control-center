package main

import (
	"bytes"
	"context"
	"encoding/json"
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
