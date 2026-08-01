package k8s

import (
	"os"
	"strings"
	"testing"
)

func TestRunWorkerImageShipsTheToolWorkerCommandUsedByThePod(t *testing.T) {
	t.Parallel()
	body, err := os.ReadFile("../../../images/run-worker/Dockerfile")
	if err != nil {
		t.Fatalf("read Run Worker Dockerfile: %v", err)
	}
	dockerfile := string(body)
	for _, required := range []string{"./cmd/tool-worker", "/out/tool-worker", "/usr/local/bin/tool-worker"} {
		if !strings.Contains(dockerfile, required) {
			t.Errorf("Run Worker Dockerfile does not contain %q", required)
		}
	}
	if strings.Contains(dockerfile, "sandbox-worker") {
		t.Error("Run Worker Dockerfile still packages the retired sandbox-worker command")
	}
}
