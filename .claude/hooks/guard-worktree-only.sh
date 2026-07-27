#!/usr/bin/env bash
# PreToolUse(Edit|Write|NotebookEdit|apply_patch|Bash) guard: no edits or
# branch-switching in the MAIN checkout of a wtp-managed repo.
#
# Why: an agent editing or `git checkout`-ing in the main checkout leaves the
# human's own terminal on the wrong branch, and skips the wtp post_create
# hooks (bun install / lefthook install) that a real worktree gets. See
# https://github.com/0x63616c/world-wide-webb/issues/182.
#
# Shared between Claude Code and Codex: both use the identical PreToolUse
# stdin schema (tool_name, tool_input.command, cwd) and the same
# hookSpecificOutput.permissionDecision=deny response shape. `apply_patch` is
# Codex's file-edit tool, equivalent to Claude's Edit/Write/NotebookEdit.
# `EnterWorktree` is Claude Code-only (no Codex equivalent); its {name}
# creation form is blocked here for the same reason as raw edits, but
# {path} (relocating into an already-wtp-created worktree) is allowed.
#
# Scope: only enforced in repos that have opted in via a `.wtp.yml` at their
# root, and only in the MAIN worktree - any linked worktree (wtp-created or
# not) is always allowed. Read-only tools and most Bash commands pass through
# untouched; only file-edit tools and a short list of branch-switching or
# destructive git verbs are denied.

input=$(cat)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$cwd" ] && cwd="$PWD"

deny() {
  reason=$1
  jq -n --arg reason "$reason" \
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$reason}}'
  exit 0
}

toplevel=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)
[ -z "$toplevel" ] && exit 0
[ -f "$toplevel/.wtp.yml" ] || exit 0

git_dir=$(git -C "$cwd" rev-parse --path-format=absolute --git-dir 2>/dev/null)
common_dir=$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
[ -z "$git_dir" ] || [ -z "$common_dir" ] && exit 0
# In a linked worktree, git-dir and git-common-dir differ. Only the main
# worktree (where they're equal) is guarded.
[ "$git_dir" = "$common_dir" ] || exit 0

case "$tool_name" in
  Edit|Write|NotebookEdit|apply_patch)
    file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null)
    case "$file_path" in
      /tmp/*|/private/tmp/*) exit 0 ;;
    esac
    deny "Edits blocked in the main checkout of a wtp-managed repo. Run 'wtp add <branch>' (or 'wtp cd <branch>' for an existing one) and work there instead."
    ;;
  EnterWorktree)
    path=$(printf '%s' "$input" | jq -r '.tool_input.path // empty' 2>/dev/null)
    [ -n "$path" ] && exit 0
    deny "EnterWorktree({name}) creates a nested .claude/worktrees/ checkout, which skips wtp's post_create hooks (bun install / lefthook install). Run 'wtp add -b <branch>' instead, then EnterWorktree({path: <path wtp printed>}) to relocate the session into it."
    ;;
  Bash)
    cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
    [ -z "$cmd" ] && exit 0
    norm=$(printf '%s' "$cmd" | tr '\n' ' ' | tr -s '[:space:]' ' ')
    pre='(^|[;&|`(]|&&|\|\|)[[:space:]]*'
    if printf '%s' "$norm" | grep -Eq "${pre}git[[:space:]]+(checkout|switch|reset[[:space:]]+--hard|branch[[:space:]]+-D|merge|rebase|cherry-pick)([[:space:]]|$)"; then
      deny "Branch-switching/destructive git commands are blocked in the main checkout. Run 'wtp add <branch>' and do this in a worktree instead."
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
