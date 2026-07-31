#!/usr/bin/env bash
set -euo pipefail

readonly policy_files=(
  AGENTS.md
  .github/pull_request_template.md
  .claude/skills/create-ticket/SKILL.md
  .claude/workflows/grind-tickets.js
  docs/runbooks/software-factory-first-run.md
)

require() {
  local pattern="$1"
  shift
  if ! grep -Eq "$pattern" "$@"; then
    echo "expected policy text matching: $pattern" >&2
    exit 1
  fi
}

reject() {
  local pattern="$1"
  shift
  if grep -En "$pattern" "$@"; then
    echo "closing-keyword guidance must use a neutral reference instead" >&2
    exit 1
  fi
}

require 'Refs #N' .github/pull_request_template.md AGENTS.md .claude/skills/create-ticket/SKILL.md .claude/workflows/grind-tickets.js
require 'manually' AGENTS.md .github/pull_request_template.md .claude/workflows/grind-tickets.js docs/runbooks/software-factory-first-run.md
reject 'Fixes #N\. GitHub closes|canonical `Fixes #N`|auto-closes an issue whose|issues auto-close|Fixes #345' "${policy_files[@]}"
