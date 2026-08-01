package agenttool_test

import (
	"context"
	"fmt"
	"strings"
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

func TestMustSetRejectsDuplicateTools(t *testing.T) {
	t.Parallel()

	first := agenttool.Bind(
		agenttool.Define[readInput]("read_file", "Read a repository file."),
		func(_ context.Context, _ readInput) (agenttool.Result, error) { return agenttool.Result{}, nil },
	)
	second := agenttool.Bind(
		agenttool.Define[semanticInput]("read_file", "Read a repository file another way."),
		func(_ context.Context, _ semanticInput) (agenttool.Result, error) { return agenttool.Result{}, nil },
	)

	defer func() {
		panicValue := recover()
		if panicValue == nil {
			t.Fatal("MustSet() did not panic")
		}
		if message := fmt.Sprint(panicValue); !strings.Contains(message, `duplicate tool "read_file"`) {
			t.Fatalf("panic = %q", message)
		}
	}()
	agenttool.MustSet("coding-read-v1", first, second)
}

func TestMustSetFingerprintIsStableAcrossRegistrationOrder(t *testing.T) {
	t.Parallel()

	read := agenttool.Bind(
		agenttool.Define[readInput]("read_file", "Read a repository file."),
		func(_ context.Context, _ readInput) (agenttool.Result, error) { return agenttool.Result{}, nil },
	)
	exec := agenttool.Bind(
		agenttool.Define[execInput]("exec_command", "Execute one argv command."),
		func(_ context.Context, _ execInput) (agenttool.Result, error) { return agenttool.Result{}, nil },
	)

	forward := agenttool.MustSet("coding-write-v1", read, exec).Fingerprint()
	reverse := agenttool.MustSet("coding-write-v1", exec, read).Fingerprint()
	if forward == "" || forward != reverse {
		t.Fatalf("fingerprints = %q and %q", forward, reverse)
	}
}
