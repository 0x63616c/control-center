#!/usr/bin/env bash
# Hermetic regression test for the wtp post-create upstream repair.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HELPER="$HERE/configure-worktree-upstream.sh"

if [ ! -x "$HELPER" ]; then
  echo "not executable: $HELPER" >&2
  exit 1
fi

# Git hooks may export repository state. Clear it so this fixture cannot write
# to the checkout that launched the test.
unset $(git rev-parse --local-env-vars) 2>/dev/null || true

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
ORIGIN="$TMP/origin.git"
SEED="$TMP/seed"
WORKTREE="$TMP/worktree"
GIT_ID=(-c user.email=test@example.com -c user.name=test -c commit.gpgsign=false)

git init --bare -q -b main "$ORIGIN"
git init -q -b main "$SEED"
git -C "$SEED" remote add origin "$ORIGIN"
printf 'seed\n' >"$SEED/README"
git -C "$SEED" add README
git -C "$SEED" "${GIT_ID[@]}" commit -qm seed
git -C "$SEED" push -qu origin main
git clone -q "$ORIGIN" "$WORKTREE"
git -C "$WORKTREE" checkout -qb feature origin/main

before_merge=$(git -C "$WORKTREE" config --get branch.feature.merge)
[ "$before_merge" = "refs/heads/main" ] || {
  echo "fixture did not inherit origin/main: $before_merge" >&2
  exit 1
}

(cd "$WORKTREE" && "$HELPER")

remote=$(git -C "$WORKTREE" config --get branch.feature.remote)
merge=$(git -C "$WORKTREE" config --get branch.feature.merge)
[ "$remote" = "origin" ] || { echo "expected origin remote, got: $remote" >&2; exit 1; }
[ "$merge" = "refs/heads/feature" ] || { echo "expected feature merge ref, got: $merge" >&2; exit 1; }

push=$(git -C "$WORKTREE" push --dry-run --porcelain)
printf '%s\n' "$push" | grep -Fq 'refs/heads/feature:refs/heads/feature' || {
  echo "bare push did not target feature:" >&2
  printf '%s\n' "$push" >&2
  exit 1
}

grep -Fq 'command: "bash scripts/configure-worktree-upstream.sh"' "$HERE/../.wtp.yml" || {
  echo ".wtp.yml does not invoke the upstream repair helper" >&2
  exit 1
}

git -C "$WORKTREE" checkout -q --detach
if detached_error=$(cd "$WORKTREE" && "$HELPER" 2>&1); then
  echo "helper unexpectedly accepted detached HEAD" >&2
  exit 1
fi
printf '%s\n' "$detached_error" | grep -Fq 'cannot configure upstream from detached HEAD' || {
  echo "helper did not explain detached HEAD failure: $detached_error" >&2
  exit 1
}

echo "configure-worktree-upstream: passed"
