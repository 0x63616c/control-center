package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestOpenAPICommandPrintsSpecWithoutStartupConfig(t *testing.T) {
	t.Setenv("SOFTWARE_FACTORY_DATABASE_URL", "")
	var stdout bytes.Buffer
	cli := newCLI(&stdout, &bytes.Buffer{})
	cli.Root().SetArgs([]string{"openapi"})
	cli.Run()
	if got := stdout.String(); !strings.Contains(got, "openapi: 3.1.0") || !strings.Contains(got, "/v1/build:") {
		t.Fatalf("openapi output = %q, want OpenAPI build endpoint", got)
	}
}
