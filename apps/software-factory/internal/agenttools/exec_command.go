package agenttools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agenttool"
)

const maxCapturedStreamBytes = 4 << 20

// ExecCommandInput is the model-facing structured process request.
type ExecCommandInput struct {
	Argv []string `json:"argv" jsonschema:"minItems=1" jsonschema_description:"Executable followed by its argument vector; no implicit shell is used."`
}

// ExecCommandOutput is the bounded result of one local process.
type ExecCommandOutput struct {
	ExitCode      int             `json:"exit_code"`
	StdoutPreview string          `json:"stdout_preview"`
	StderrPreview string          `json:"stderr_preview"`
	StdoutRef     agent.OutputRef `json:"stdout_ref,omitempty"`
	StderrRef     agent.OutputRef `json:"stderr_ref,omitempty"`
	StdoutDropped bool            `json:"stdout_dropped"`
	StderrDropped bool            `json:"stderr_dropped"`
}

// NewExecCommand builds an argv-only command tool rooted in the repository.
func NewExecCommand(
	repositoryRoot string,
	artifactIdentity string,
	artifacts agent.ArtifactStore,
	maxInlineBytes int,
	timeout time.Duration,
) (*agenttool.BoundTool[ExecCommandInput], error) {
	return newExecCommand(repositoryRoot, artifactIdentity, artifacts, maxInlineBytes, timeout, nil)
}

// NewReadOnlyExecCommand builds the capability-restricted exec_command used by plan and review.
func NewReadOnlyExecCommand(
	repositoryRoot string,
	artifactIdentity string,
	artifacts agent.ArtifactStore,
	maxInlineBytes int,
	timeout time.Duration,
) (*agenttool.BoundTool[ExecCommandInput], error) {
	return newExecCommand(repositoryRoot, artifactIdentity, artifacts, maxInlineBytes, timeout, readOnlyCommand)
}

func newExecCommand(
	repositoryRoot string,
	artifactIdentity string,
	artifacts agent.ArtifactStore,
	maxInlineBytes int,
	timeout time.Duration,
	policy func([]string) error,
) (*agenttool.BoundTool[ExecCommandInput], error) {
	if !filepath.IsAbs(repositoryRoot) || artifactIdentity == "" || maxInlineBytes < 1 || timeout <= 0 {
		return nil, fmt.Errorf("exec_command needs artifact identity, positive preview size, and positive timeout")
	}
	definition := agenttool.Define[ExecCommandInput]("exec_command", "Execute one explicit argv command in the ticket repository.")
	return agenttool.Bind(definition, func(ctx context.Context, input ExecCommandInput) (agenttool.Result, error) {
		root, err := resolveRepositoryRoot(repositoryRoot)
		if err != nil {
			return toolError("repository is unavailable: %v", err), nil
		}
		if policy != nil {
			if err := policy(input.Argv); err != nil {
				return toolError("read-only exec_command rejected argv: %v", err), nil
			}
		}
		return executeCommand(ctx, root, artifactIdentity, artifacts, maxInlineBytes, timeout, input)
	}), nil
}

func readOnlyCommand(argv []string) error {
	command := filepath.Base(argv[0])
	switch command {
	case "git":
		if len(argv) < 2 {
			return fmt.Errorf("git subcommand is required")
		}
		allowed := map[string]bool{
			"status": true, "diff": true, "show": true, "log": true, "grep": true,
			"rev-parse": true, "ls-files": true,
		}
		if !allowed[argv[1]] {
			return fmt.Errorf("git subcommand %q is mutating or unsupported", argv[1])
		}
	case "rg":
	default:
		return fmt.Errorf("command %q is not allowlisted", command)
	}
	for _, argument := range argv[1:] {
		value := argument
		if _, after, found := strings.Cut(argument, "="); found {
			value = after
		}
		if filepath.IsAbs(value) || value == ".." || strings.HasPrefix(filepath.Clean(value), ".."+string(filepath.Separator)) {
			return fmt.Errorf("path argument %q escapes the repository", argument)
		}
		for _, forbidden := range []string{
			"-c", "--config-env", "--git-dir", "--work-tree", "--exec-path", "--upload-pack", "--ext-diff", "--textconv", "--pre",
		} {
			if argument == forbidden || strings.HasPrefix(argument, forbidden+"=") {
				return fmt.Errorf("option %q can escape read-only execution", argument)
			}
		}
	}
	return nil
}

func executeCommand(
	ctx context.Context,
	root, artifactIdentity string,
	artifacts agent.ArtifactStore,
	maxInlineBytes int,
	timeout time.Duration,
	input ExecCommandInput,
) (agenttool.Result, error) {
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := exec.CommandContext(runCtx, input.Argv[0], input.Argv[1:]...)
	command.Dir = root
	stdout := &cappedCapture{max: maxCapturedStreamBytes}
	stderr := &cappedCapture{max: maxCapturedStreamBytes}
	command.Stdout = stdout
	command.Stderr = stderr
	err := command.Run()
	if ctx.Err() != nil {
		return agenttool.Result{}, fmt.Errorf("execute command: %w", ctx.Err())
	}
	if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		return toolError("command exceeded its %s timeout", timeout), nil
	}
	exitCode := 0
	if err != nil {
		var exitError *exec.ExitError
		if !errors.As(err, &exitError) {
			return toolError("command could not start: %v", err), nil
		}
		exitCode = exitError.ExitCode()
	}
	output := ExecCommandOutput{
		ExitCode:      exitCode,
		StdoutPreview: preview(stdout.Bytes(), maxInlineBytes),
		StderrPreview: preview(stderr.Bytes(), maxInlineBytes),
		StdoutDropped: stdout.dropped,
		StderrDropped: stderr.dropped,
	}
	if len(stdout.Bytes()) > maxInlineBytes {
		ref, err := artifacts.StoreOutput(ctx, artifactIdentity, stdout.Bytes())
		if err != nil {
			return agenttool.Result{}, fmt.Errorf("store exec_command stdout: %w", err)
		}
		output.StdoutRef = ref
	}
	if len(stderr.Bytes()) > maxInlineBytes {
		ref, err := artifacts.StoreOutput(ctx, artifactIdentity, stderr.Bytes())
		if err != nil {
			return agenttool.Result{}, fmt.Errorf("store exec_command stderr: %w", err)
		}
		output.StderrRef = ref
	}
	encoded, err := json.Marshal(output)
	if err != nil {
		return agenttool.Result{}, fmt.Errorf("encode exec_command output: %w", err)
	}
	return agenttool.Result{Content: string(encoded), IsError: exitCode != 0}, nil
}

type cappedCapture struct {
	bytes.Buffer
	max     int
	dropped bool
}

func (capture *cappedCapture) Write(value []byte) (int, error) {
	originalLength := len(value)
	remaining := capture.max - capture.Len()
	if remaining <= 0 {
		capture.dropped = true
		return originalLength, nil
	}
	if len(value) > remaining {
		value = value[:remaining]
		capture.dropped = true
	}
	_, _ = capture.Buffer.Write(value)
	return originalLength, nil
}

func preview(value []byte, maximum int) string {
	if len(value) > maximum {
		value = value[:maximum]
	}
	return string(value)
}
