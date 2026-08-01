package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
