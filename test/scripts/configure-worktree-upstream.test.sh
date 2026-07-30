#!/usr/bin/env bash
# Hermetic regression test for the wtp post-create upstream repair.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
HELPER="$ROOT/scripts/configure-worktree-upstream.sh"

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
BRANCH="sf/feature"
GIT_ID=(-c user.email=test@example.com -c user.name=test -c commit.gpgsign=false)

git init --bare -q -b main "$ORIGIN"
git init -q -b main "$SEED"
git -C "$SEED" remote add origin "$ORIGIN"
printf 'seed\n' >"$SEED/README"
git -C "$SEED" add README
git -C "$SEED" "${GIT_ID[@]}" commit -qm seed
git -C "$SEED" push -qu origin main
git clone -q "$ORIGIN" "$WORKTREE"
git -C "$WORKTREE" checkout -qb "$BRANCH" origin/main

before_merge=$(git -C "$WORKTREE" config --get "branch.$BRANCH.merge")
[ "$before_merge" = "refs/heads/main" ] || {
  echo "fixture did not inherit origin/main: $before_merge" >&2
  exit 1
}

(cd "$WORKTREE" && "$HELPER")

remote=$(git -C "$WORKTREE" config --get "branch.$BRANCH.remote")
merge=$(git -C "$WORKTREE" config --get "branch.$BRANCH.merge")
[ "$remote" = "origin" ] || { echo "expected origin remote, got: $remote" >&2; exit 1; }
[ "$merge" = "refs/heads/$BRANCH" ] || { echo "expected feature merge ref, got: $merge" >&2; exit 1; }

PRESERVED_BRANCH="existing"
PRESERVED_MERGE="refs/heads/release"
git -C "$WORKTREE" checkout -qb "$PRESERVED_BRANCH" "$BRANCH"
git -C "$WORKTREE" config "branch.$PRESERVED_BRANCH.remote" origin
git -C "$WORKTREE" config "branch.$PRESERVED_BRANCH.merge" "$PRESERVED_MERGE"
(cd "$WORKTREE" && "$HELPER")

preserved_remote=$(git -C "$WORKTREE" config --get "branch.$PRESERVED_BRANCH.remote")
preserved_merge=$(git -C "$WORKTREE" config --get "branch.$PRESERVED_BRANCH.merge")
[ "$preserved_remote" = "origin" ] || { echo "expected preserved origin remote, got: $preserved_remote" >&2; exit 1; }
[ "$preserved_merge" = "$PRESERVED_MERGE" ] || {
  echo "expected preserved merge ref $PRESERVED_MERGE, got: $preserved_merge" >&2
  exit 1
}

# An unpublished branch someone is already working on, deliberately tracking
# main. It has no remote ref, so the remote-ref guard alone would retarget it
# and silently change what `git pull` and a bare `git push` do to work in
# progress. Its own commits are what mark it as not-just-created.
INPROGRESS_BRANCH="inprogress"
git -C "$WORKTREE" checkout -qb "$INPROGRESS_BRANCH" origin/main
git -C "$WORKTREE" config "branch.$INPROGRESS_BRANCH.remote" origin
git -C "$WORKTREE" config "branch.$INPROGRESS_BRANCH.merge" refs/heads/main
printf 'work in progress\n' >"$WORKTREE/WIP"
git -C "$WORKTREE" add WIP
git -C "$WORKTREE" "${GIT_ID[@]}" commit -qm "work in progress"
(cd "$WORKTREE" && "$HELPER")

inprogress_merge=$(git -C "$WORKTREE" config --get "branch.$INPROGRESS_BRANCH.merge")
[ "$inprogress_merge" = "refs/heads/main" ] || {
  echo "expected unpushed in-progress branch to retain main upstream, got: $inprogress_merge" >&2
  exit 1
}

PUBLISHED_BRANCH="published"
git -C "$WORKTREE" checkout -qb "$PUBLISHED_BRANCH" "$BRANCH"
git -C "$WORKTREE" push -q origin "refs/heads/$PUBLISHED_BRANCH:refs/heads/$PUBLISHED_BRANCH"
git -C "$WORKTREE" fetch -q origin "$PUBLISHED_BRANCH"
git -C "$WORKTREE" config "branch.$PUBLISHED_BRANCH.remote" origin
git -C "$WORKTREE" config "branch.$PUBLISHED_BRANCH.merge" refs/heads/main
(cd "$WORKTREE" && "$HELPER")

published_merge=$(git -C "$WORKTREE" config --get "branch.$PUBLISHED_BRANCH.merge")
[ "$published_merge" = "refs/heads/main" ] || {
  echo "expected existing published branch to retain main upstream, got: $published_merge" >&2
  exit 1
}

git -C "$WORKTREE" checkout -q "$BRANCH"
push=$(git -C "$WORKTREE" -c push.default=simple push --dry-run --porcelain)
printf '%s\n' "$push" | grep -Fq "refs/heads/$BRANCH:refs/heads/$BRANCH" || {
  echo "bare push did not target feature:" >&2
  printf '%s\n' "$push" >&2
  exit 1
}

upstream_line=$(grep -n -F 'command: "bash scripts/configure-worktree-upstream.sh"' "$ROOT/.wtp.yml" | cut -d: -f1)
bun_install_line=$(grep -n -F 'command: "bun install"' "$ROOT/.wtp.yml" | cut -d: -f1)
[ -n "$upstream_line" ] || {
  echo ".wtp.yml does not invoke the upstream repair helper" >&2
  exit 1
}
[ "$upstream_line" -lt "$bun_install_line" ] || {
  echo ".wtp.yml runs the upstream repair after fallible setup" >&2
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
