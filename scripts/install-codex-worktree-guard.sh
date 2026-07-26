#!/usr/bin/env bash
# Idempotently wire the worktree-only guard (.claude/hooks/guard-worktree-only.sh)
# into the user's global Codex hooks.json as a PreToolUse hook.
#
# Why a script instead of hand-editing ~/.codex/hooks.json: that file is
# global (every Codex project, not just this repo) and partly managed by
# cmux ("supacode-managed-hook" markers) - hand-editing risks malformed JSON
# breaking every Codex session on the machine. This mirrors the repo's
# no-manual-machine-changes convention: codify it in a checked-in, idempotent
# script instead.
#
# The guard script itself scopes enforcement to repos with a `.wtp.yml` at
# their root, so wiring it globally here does not affect any other project.
#
# Usage:
#   scripts/install-codex-worktree-guard.sh           # install (idempotent)
#   scripts/install-codex-worktree-guard.sh --check   # exit 0 if already installed, 1 otherwise
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARD_SCRIPT="$REPO_ROOT/.claude/hooks/guard-worktree-only.sh"
HOOKS_JSON="${CODEX_HOOKS_JSON:-$HOME/.codex/hooks.json}"
MARKER="guard-worktree-only.sh"

if [ ! -f "$GUARD_SCRIPT" ]; then
  echo "error: $GUARD_SCRIPT not found" >&2
  exit 1
fi

if [ ! -f "$HOOKS_JSON" ]; then
  echo "error: $HOOKS_JSON not found - is Codex installed?" >&2
  exit 1
fi

already_installed() {
  jq -e --arg marker "$MARKER" '
    (.hooks.PreToolUse // [])
    | any(.hooks[]?.command // "" | contains($marker))
  ' "$HOOKS_JSON" >/dev/null 2>&1
}

if already_installed; then
  echo "already installed: $HOOKS_JSON"
  exit 0
fi

if [ "${1:-}" = "--check" ]; then
  echo "not installed: $HOOKS_JSON"
  exit 1
fi

tmp=$(mktemp)
jq --arg cmd "$GUARD_SCRIPT" '
  .hooks.PreToolUse = ((.hooks.PreToolUse // []) + [{
    "hooks": [
      { "type": "command", "command": $cmd, "timeout": 5 }
    ]
  }])
' "$HOOKS_JSON" > "$tmp"

# Sanity-check the result parses before replacing the live file.
jq empty "$tmp"
cp "$HOOKS_JSON" "$HOOKS_JSON.bak"
mv "$tmp" "$HOOKS_JSON"
echo "installed: $HOOKS_JSON (backup at $HOOKS_JSON.bak)"
