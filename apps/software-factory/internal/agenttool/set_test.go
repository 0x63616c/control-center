package agenttool_test

import (
	"context"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agenttool"
)

type execInput struct {
	Argv []string `json:"argv" jsonschema:"minItems=1" jsonschema_description:"Command and arguments to execute."`
}

func TestMustSetSortsSpecifications(t *testing.T) {
	t.Parallel()

	read := agenttool.Bind(
		agenttool.Define[readInput]("read_file", "Read a repository file."),
		func(_ context.Context, _ readInput) (agenttool.Result, error) { return agenttool.Result{}, nil },
	)
	exec := agenttool.Bind(
		agenttool.Define[execInput]("exec_command", "Execute one argv command."),
		func(_ context.Context, _ execInput) (agenttool.Result, error) { return agenttool.Result{}, nil },
	)

	set := agenttool.MustSet("coding-write-v1", read, exec)
	specifications := set.Specifications()
	if len(specifications) != 2 {
		t.Fatalf("len(Specifications()) = %d, want 2", len(specifications))
	}
	if specifications[0].Name != "exec_command" || specifications[1].Name != "read_file" {
		t.Fatalf("Specifications() names = [%q, %q]", specifications[0].Name, specifications[1].Name)
	}
}
