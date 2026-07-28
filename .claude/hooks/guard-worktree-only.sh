#!/usr/bin/env bash
# PreToolUse(Edit|Write|NotebookEdit|apply_patch|Bash|EnterWorktree) guard for
# wtp-managed repos. Two jobs:
#
#   1. Keep writes and branch switches out of the MAIN checkout. Several agent
#      sessions share it at once; an edit or checkout there silently rewrites
#      every other session's working tree, and skips the wtp post_create hooks
#      (bun install / lefthook install) a real worktree gets. See
#      https://github.com/0x63616c/world-wide-webb/issues/182.
#   2. Keep cross-session destructive git verbs out of EVERY session.
#      `git worktree remove` and `git branch -D` destroy work owned by sessions
#      the caller cannot see, so they are denied from anywhere in the repo, not
#      only from the main checkout.
#
# Decisions come from the TARGET of the call, never from `cwd` alone. The Bash
# tool's cwd persists across calls, so a session that had once `cd`-ed into a
# worktree kept satisfying a cwd-only check while still writing to main.
#
# Shared between Claude Code and Codex: both use the identical PreToolUse stdin
# schema (tool_name, tool_input.command, cwd) and the same
# hookSpecificOutput.permissionDecision=deny response shape. `apply_patch` is
# Codex's file-edit tool, equivalent to Claude's Edit/Write/NotebookEdit.
# `EnterWorktree` is Claude Code-only and is denied outright - see below.
#
# Scope: only enforced in repos that have opted in via a `.wtp.yml` at their
# root. Read-only tools and most Bash commands pass through untouched.

input=$(cat)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$cwd" ] && cwd="$PWD"

# Every line of a Bash command is treated as a command start, so a commit
# message written inline can be misread as an invocation. Say so in the denial
# rather than leaving the caller to invent a workaround.
PROSE_HINT="If this is prose (a commit message body, a heredoc), write it to a file and pass it with -F <file> so no line of it looks like a command."

deny() {
  jq -n --arg reason "$1" \
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$reason}}'
  exit 0
}

# Absolute path to the repo's MAIN worktree, resolved from any linked worktree.
# git-common-dir always points at the main checkout's .git, so its parent is the
# main worktree root regardless of where this call came from.
main_root_from() {
  common=$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  [ -n "$common" ] || return 1
  printf '%s' "${common%/.git}"
}

# Nearest existing ancestor of a path - a Write may target a file, or a
# directory, that does not exist yet.
existing_ancestor() {
  d=$1
  while [ ! -d "$d" ] && [ "$d" != "/" ] && [ -n "$d" ]; do d=$(dirname "$d"); done
  printf '%s' "$d"
}

main_root=$(main_root_from "$cwd") || main_root=""
# cwd may be stale or outside the repo; fall back to the project dir Claude Code
# exports with every hook call. With neither, there is no repo context to police
# and the call passes through.
if [ -z "$main_root" ] && [ -n "$CLAUDE_PROJECT_DIR" ]; then
  main_root=$(main_root_from "$CLAUDE_PROJECT_DIR") || main_root=""
fi
[ -n "$main_root" ] || exit 0
[ -f "$main_root/.wtp.yml" ] || exit 0

case "$tool_name" in
  Edit|Write|NotebookEdit|apply_patch)
    file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null)
    [ -n "$file_path" ] || exit 0
    case "$file_path" in
      /tmp/*|/private/tmp/*) exit 0 ;;
      /*) ;;
      *) file_path="$cwd/$file_path" ;;
    esac

    target_dir=$(existing_ancestor "$(dirname "$file_path")")
    target_git=$(git -C "$target_dir" rev-parse --path-format=absolute --git-dir 2>/dev/null)
    target_common=$(git -C "$target_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
    # Not a git repo, or unreadable: not ours to police.
    [ -n "$target_git" ] && [ -n "$target_common" ] || exit 0
    # In a linked worktree git-dir and git-common-dir differ. Only writes whose
    # TARGET is the main worktree are denied - the session's own cwd is
    # irrelevant, so driving a worktree by absolute path from a main-checkout
    # session is allowed, and is the supported way for an agent to work.
    [ "$target_git" = "$target_common" ] || exit 0
    deny "Write to the MAIN checkout blocked ($file_path). Concurrent sessions share it. Run 'wtp add -b <branch> origin/main', then edit via the absolute worktree path it prints - your session stays where it is; EnterWorktree does not work with wtp worktrees."
    ;;

  EnterWorktree)
    deny "EnterWorktree is not usable in this repo. It only accepts worktrees it created under '$main_root/.claude/worktrees', but wtp puts worktrees outside the repo (see .wtp.yml), so {path:...} is rejected by the harness and {name:...} would create a nested checkout that skips wtp's post_create hooks. Do not relocate the session: run 'wtp add -b <branch> origin/main' and drive that worktree by absolute path - 'git -C <worktree> ...' and absolute <worktree>/... paths for Edit/Write."
    ;;

  Bash)
    cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
    [ -z "$cmd" ] && exit 0
    # A newline starts a new command, so it must count as a separator - a
    # multi-line Bash block is the ordinary way to write several commands, and
    # folding newlines into spaces let the second line onward slip past.
    norm=$(printf '%s' "$cmd" | tr '\n' ';' | tr -s '[:blank:]' ' ')
    # A git verb only counts at the start of a command, not mid-string, so
    # prose, heredocs and message bodies do not trip the guard. Backtick is
    # deliberately NOT a separator here: legacy `cmd` substitution is
    # vanishingly rare next to markdown code spans, and treating it as one made
    # every commit message that mentioned `git switch` undeliverable.
    pre='(^|[;&|(]|&&|\|\|)[[:space:]]*'

    # Denied from ANY worktree: these reach across sessions. A worktree that
    # looks abandoned is usually another agent's live work, and a force-deleted
    # branch can be unrecoverable. Stale worktrees are reaped by the hourly
    # prune job, not by hand.
    if printf '%s' "$norm" | grep -Eq "${pre}git[[:space:]]+worktree[[:space:]]+(remove|prune)([[:space:]]|$)"; then
      deny "'git worktree remove/prune' is blocked: other sessions own worktrees you cannot see, and an idle-looking one is usually someone's live work. Stale worktrees are reaped by the hourly prune job. If you are certain, ask the human to run it. $PROSE_HINT"
    fi
    if printf '%s' "$norm" | grep -Eq "${pre}git[[:space:]]+branch[[:space:]]+(-D|-d|--delete|--force-delete)([[:space:]]|$)"; then
      deny "'git branch -D/-d' is blocked: the branch may be checked out in another session's worktree. Merged PR branches are cleaned up by 'gh pr merge --delete-branch'. $PROSE_HINT"
    fi

    # Branch-switching and history-rewriting verbs are fine inside a linked
    # worktree, fatal in the main checkout. Allow when the command explicitly
    # targets a linked worktree path ('cd <wt> && ...' or 'git -C <wt> ...');
    # otherwise judge by cwd.
    # Tolerate global options before the verb ('git -C <path> switch'). Only
    # flag-shaped or absolute-path-shaped tokens are skipped, never bare words,
    # so a quoted message body like -m 'docs: explain git switch' cannot be
    # mistaken for an invocation.
    opt='((-[^[:space:]]*|/[^[:space:]]+)[[:space:]]+)*'
    if printf '%s' "$norm" | grep -Eq "${pre}git[[:space:]]+${opt}(checkout|switch|merge|rebase|cherry-pick)([[:space:]]|$)" ||
      printf '%s' "$norm" | grep -Eq "${pre}git[[:space:]]+${opt}reset[[:space:]]+--hard([[:space:]]|$)"; then
      # An explicit reference to the main checkout is always the main checkout,
      # even when the call comes from a worktree ('git -C <main> switch ...').
      case "$norm" in
        *"$main_root"*)
          deny "This command targets the MAIN checkout ($main_root), whose working tree is shared by concurrent sessions. Run it against a worktree instead: 'git -C <worktree> ...'. $PROSE_HINT"
          ;;
      esac
      while IFS= read -r wt; do
        [ -n "$wt" ] || continue
        [ "$wt" = "$main_root" ] && continue
        case "$norm" in *"$wt"*) exit 0 ;; esac
      done <<EOF
$(git -C "$main_root" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
EOF
      cwd_git=$(git -C "$cwd" rev-parse --path-format=absolute --git-dir 2>/dev/null)
      cwd_common=$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
      # Unknown or stale cwd is treated as the main checkout: fail closed.
      if [ -z "$cwd_git" ] || [ "$cwd_git" = "$cwd_common" ]; then
        deny "Branch-switching git commands are blocked in the MAIN checkout - concurrent sessions share its working tree. Run 'wtp add -b <branch> origin/main' and target that worktree explicitly ('git -C <worktree> ...'). $PROSE_HINT"
      fi
    fi
    exit 0
    ;;

  *)
    exit 0
    ;;
esac
