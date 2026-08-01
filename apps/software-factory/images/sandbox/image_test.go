package sandbox

import (
	"os"
	"strings"
	"testing"
)

func TestProductionSandboxDoesNotInstallOrInvokeCodexCLI(t *testing.T) {
	t.Parallel()
	for _, path := range []string{"Dockerfile", "smoke.sh"} {
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("reading %s: %v", path, err)
		}
		for _, forbidden := range []string{"CODEX_VERSION", "/usr/local/bin/codex", "codex exec", "codex --version"} {
			if strings.Contains(string(content), forbidden) {
				t.Errorf("%s still contains %q", path, forbidden)
			}
		}
	}
}
