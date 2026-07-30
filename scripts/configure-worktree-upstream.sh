#!/usr/bin/env bash
# Repair the upstream inherited when `git branch` starts from origin/main.

set -euo pipefail

if ! branch=$(git symbolic-ref --quiet --short HEAD); then
  echo "configure-worktree-upstream: cannot configure upstream from detached HEAD" >&2
  exit 1
fi

# The remote branch does not exist during wtp post_create, so setting upstream
# through `git branch --set-upstream-to` would fail. Write its eventual ref
# directly instead, replacing the origin/main tracking Git inherited at branch
# creation time.
git config --local "branch.$branch.remote" origin
git config --local "branch.$branch.merge" "refs/heads/$branch"
