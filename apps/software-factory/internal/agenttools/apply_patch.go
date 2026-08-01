package agenttools

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agenttool"
)

// ApplyPatchInput is the model-facing unified-diff request.
type ApplyPatchInput struct {
	Patch string `json:"patch" jsonschema:"minLength=1,maxLength=1048576" jsonschema_description:"Unified diff to apply inside the ticket repository."`
}

// NewApplyPatch builds a git-apply tool rooted in the repository.
func NewApplyPatch(repositoryRoot string, timeout time.Duration) (*agenttool.BoundTool[ApplyPatchInput], error) {
	root, err := filepath.EvalSymlinks(repositoryRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve repository root: %w", err)
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("make repository root absolute: %w", err)
	}
	if timeout <= 0 {
		return nil, fmt.Errorf("apply_patch timeout must be positive")
	}
	definition := agenttool.Define[ApplyPatchInput]("apply_patch", "Apply one unified diff inside the ticket repository.")
	return agenttool.Bind(definition, func(ctx context.Context, input ApplyPatchInput) (agenttool.Result, error) {
		runCtx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		command := exec.CommandContext(runCtx, "git", "apply", "--whitespace=nowarn", "-")
		command.Dir = root
		command.Stdin = strings.NewReader(input.Patch)
		var stdout, stderr bytes.Buffer
		command.Stdout = &stdout
		command.Stderr = &stderr
		err := command.Run()
		if ctx.Err() != nil {
			return agenttool.Result{}, fmt.Errorf("apply patch: %w", ctx.Err())
		}
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			return toolError("patch rejected: git apply exceeded its %s timeout", timeout), nil
		}
		if err != nil {
			message := strings.TrimSpace(stderr.String())
			if len(message) > 512 {
				message = message[:512]
			}
			return toolError("patch rejected: %s", message), nil
		}
		return agenttool.Result{Content: `{"applied":true}`}, nil
	}), nil
}
