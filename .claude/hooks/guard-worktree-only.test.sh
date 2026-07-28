#!/usr/bin/env bash
# Table test for guard-worktree-only.sh.
#
#   bash .claude/hooks/guard-worktree-only.test.sh
#
# Builds a throwaway git repo with one linked worktree and feeds the guard the
# same PreToolUse JSON Claude Code would. Self-contained on purpose: the guard's
# whole job is to tell a main checkout from a linked worktree, so testing it
# against the developer's real worktrees would make the result depend on
# whatever branches happen to exist today.

set -u
HOOK=${1:-"$(cd "$(dirname "$0")" && pwd)/guard-worktree-only.sh"}
[ -x "$HOOK" ] || { echo "not executable: $HOOK" >&2; exit 1; }

# Git exports GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE to hook processes, and
# `git -C <dir>` does NOT override them. Run from a pre-commit hook without
# clearing them and every fixture command below lands on the REAL repository:
# the first version of this test set core.bare=true and user.email=test on this
# repo, which broke `git status` for every session and mis-authored two peer
# commits. Clear them before touching git, and never persist config.
unset $(git rev-parse --local-env-vars) 2>/dev/null || true

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
TMP=$(cd "$TMP" && pwd -P) # macOS mktemp hands back a /var symlink; git reports /private/var

MAIN=$TMP/repo
WT=$TMP/worktrees/feature
ID="-c user.email=t@example.com -c user.name=test -c commit.gpgsign=false"
mkdir -p "$MAIN"
git -C "$MAIN" init -q -b main

# Belt and braces: if anything above still resolved to a real repository,
# stop before writing to it.
top=$(git -C "$MAIN" rev-parse --show-toplevel 2>/dev/null || echo "")
[ "$top" = "$MAIN" ] || {
  echo "fixture escaped: expected toplevel $MAIN, got '${top:-<none>}' - refusing to continue" >&2
  exit 1
}

: >"$MAIN/.wtp.yml" # opts the fixture into the guard
: >"$MAIN/AGENTS.md"
git -C "$MAIN" add -A
# shellcheck disable=SC2086 # $ID is a deliberate list of git -c flags
git -C "$MAIN" $ID commit -qm init
git -C "$MAIN" worktree add -q -b feature "$WT"

# Claude Code sets this on every hook call; the guard falls back to it when cwd
# is stale or outside the repo.
export CLAUDE_PROJECT_DIR=$MAIN

pass=0
fail=0

run() { # expect desc json
  out=$(printf '%s' "$3" | "$HOOK" 2>&1)
  if printf '%s' "$out" | grep -q '"deny"'; then got=DENY; else got=ALLOW; fi
  if [ "$got" = "$1" ]; then
    pass=$((pass + 1))
    printf 'ok   %-5s %s\n' "$got" "$2"
  else
    fail=$((fail + 1))
    printf 'FAIL want=%s got=%s  %s\n     %s\n' "$1" "$got" "$2" "$out"
  fi
}
edit() { # expect desc cwd file
  run "$1" "$2" "$(jq -n --arg c "$3" --arg f "$4" \
    '{tool_name:"Edit",cwd:$c,tool_input:{file_path:$f}}')"
}
bash_c() { # expect desc cwd cmd
  run "$1" "$2" "$(jq -n --arg c "$3" --arg x "$4" \
    '{tool_name:"Bash",cwd:$c,tool_input:{command:$x}}')"
}

echo "--- Edit: judged by target, not cwd"
edit DENY  "main file, cwd=main"                "$MAIN" "$MAIN/AGENTS.md"
edit DENY  "main file, cwd=worktree"            "$WT"   "$MAIN/AGENTS.md"
edit ALLOW "worktree file, cwd=main"            "$MAIN" "$WT/AGENTS.md"
edit ALLOW "worktree file, cwd=worktree"        "$WT"   "$WT/AGENTS.md"
edit ALLOW "new file in a new worktree subdir"  "$MAIN" "$WT/features/new/api.ts"
edit DENY  "new file in a new main subdir"      "$WT"   "$MAIN/features/new/api.ts"
edit ALLOW "scratchpad"                         "$MAIN" "/private/tmp/claude-501/x/y.sh"
edit ALLOW "outside any repo"                   "$MAIN" "$TMP/loose.txt"
edit DENY  "relative path, cwd=main"            "$MAIN" "AGENTS.md"
edit ALLOW "relative path, cwd=worktree"        "$WT"   "AGENTS.md"

echo "--- EnterWorktree: both forms are dead here"
run DENY "EnterWorktree({path})" "$(jq -n --arg c "$MAIN" --arg p "$WT" \
  '{tool_name:"EnterWorktree",cwd:$c,tool_input:{path:$p}}')"
run DENY "EnterWorktree({name})" "$(jq -n --arg c "$MAIN" \
  '{tool_name:"EnterWorktree",cwd:$c,tool_input:{name:"foo"}}')"

echo "--- Bash: cross-session destruction denied from anywhere"
bash_c DENY  "git worktree remove, cwd=worktree" "$WT"   "git worktree remove /x"
bash_c DENY  "git worktree prune, cwd=worktree"  "$WT"   "git worktree prune"
bash_c DENY  "git branch -D after &&"            "$WT"   "git fetch && git branch -D other"
bash_c DENY  "remove+delete+switch chain"        "$WT"   "git worktree remove $WT && git branch -D feature && git switch -c feature origin/main"
bash_c ALLOW "git worktree list"                 "$MAIN" "git worktree list"
bash_c ALLOW "git worktree add"                  "$MAIN" "git worktree add /tmp/x -b y"

echo "--- Bash: branch switching and history rewriting"
bash_c DENY  "git switch, cwd=main"              "$MAIN" "git switch -c x origin/main"
bash_c ALLOW "git switch, cwd=worktree"          "$WT"   "git switch -c x origin/main"
bash_c DENY  "git -C main switch, cwd=worktree"  "$WT"   "git -C $MAIN switch main"
bash_c ALLOW "git -C worktree rebase, cwd=main"  "$MAIN" "git -C $WT rebase origin/main"
bash_c ALLOW "cd worktree && rebase, cwd=main"   "$MAIN" "cd $WT && git rebase origin/main"
bash_c DENY  "git reset --hard, cwd=main"        "$MAIN" "git reset --hard origin/main"
bash_c ALLOW "git reset (soft), cwd=main"        "$MAIN" "git reset HEAD~1"
bash_c DENY  "stale cwd fails shut"              "/no/such/dir" "git switch main"
bash_c DENY  "verb on line 2 of a block"         "$MAIN" "echo hi
git switch main"
bash_c ALLOW "line 2 targets a worktree"         "$MAIN" "echo hi
git -C $WT switch -c x"

echo "--- Bash: everyday commands still pass"
bash_c ALLOW "git status"                        "$MAIN" "git status --porcelain"
bash_c ALLOW "git fetch"                         "$MAIN" "git fetch origin main"
bash_c ALLOW "commit in worktree"                "$MAIN" "git -C $WT commit -m 'fix: thing'"
bash_c ALLOW "push in worktree"                  "$MAIN" "git -C $WT push -u origin HEAD"
bash_c ALLOW "verb only inside a commit message" "$MAIN" "git -C $WT commit -m 'docs: explain git switch and git rebase'"
bash_c ALLOW "verb only inside a grep pattern"   "$MAIN" "grep -rn 'git checkout' AGENTS.md"
bash_c ALLOW "verbs in a markdown code span"     "$MAIN" "git -C $WT commit -F - <<'M'
docs: describe the guard

It denies \`git worktree remove\`, \`git branch -D\` and \`git switch -c\`.
M"
bash_c DENY  "real chained switch in a heredoc"  "$MAIN" "cat <<'M'
hi
M
git switch main"
bash_c ALLOW "gh pr create"                      "$MAIN" "gh pr create --fill"
bash_c ALLOW "typecheck in worktree"             "$MAIN" "cd $WT && bun run typecheck"

echo
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
