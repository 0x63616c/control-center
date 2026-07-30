#!/usr/bin/env bash
# Repair the upstream inherited when `git branch` starts from origin/main.

set -euo pipefail

if ! branch=$(git symbolic-ref --quiet --short HEAD); then
  echo "configure-worktree-upstream: cannot configure upstream from detached HEAD" >&2
  exit 1
fi

# `wtp add <branch>` also runs post_create for existing branches. Only repair
# the exact origin/main tracking that Git inherits when creating a branch from
# origin/main; leave every other established upstream alone.
upstream_remote=$(git config --get "branch.$branch.remote" 2>/dev/null || true)
upstream_merge=$(git config --get "branch.$branch.merge" 2>/dev/null || true)
if [ "$upstream_remote" != "origin" ] || [ "$upstream_merge" != "refs/heads/main" ]; then
  exit 0
fi

# A same-named remote branch makes this an existing worktree branch rather than
# the just-created, not-yet-pushed branch that inherited origin/main.
if git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
  exit 0
fi

# The absence of a remote ref is NOT on its own evidence that this branch was
# just created: a branch someone made earlier, deliberately tracking main, and
# has not pushed looks identical by that test alone. Retargeting it would
# silently change what `git pull` and a bare `git push` mean for work already in
# progress.
#
# What separates the two is history. `wtp add -b <new> origin/main` runs this
# hook the instant the branch is created, so HEAD is still exactly origin/main.
# A branch anyone has actually worked on has moved past it, and is left alone.
#
# A branch that exists but carries no commits of its own is repaired, and that
# is correct rather than a hole in the test: it is indistinguishable from a
# fresh one because it IS one in every way that matters here.
if [ "$(git rev-parse HEAD)" != "$(git rev-parse refs/remotes/origin/main)" ]; then
  exit 0
fi

# The remote branch does not exist during wtp post_create, so setting upstream
# through `git branch --set-upstream-to` would fail. Write its eventual ref
# directly instead.
git config --local "branch.$branch.remote" origin
git config --local "branch.$branch.merge" "refs/heads/$branch"
