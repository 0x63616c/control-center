#!/usr/bin/env bash
# Guard: everything CI BUILDS, CI must also DEPLOY.
#
# The bug this exists to make impossible, found live on #355: a product tree
# had its own path filter and its own build jobs, but that filter appeared in no
# term of `deploy-home-server`'s `if:`. So the tree built, tested and merged
# green — and never reached prod. Every PR in the project said "merged" and none
# of them said "running", with nothing red anywhere to say so.
#
# It is not enough to check that a filter is NAMED in the gate: `any_app` covers
# several trees by path, and a new build job may legitimately ride on it. So the
# check is by PATH — every path a build job is gated on must be covered by some
# path the deploy job is gated on.
#
# Sibling of test-build-matrix.sh, and grep/awk for the same reason: a YAML
# parser here would be a dependency the root workspace does not have.
set -euo pipefail
f=.github/workflows/ci.yml

# name<TAB>path, one line per path, for every entry in the `filters:` block.
filters() {
  awk '
    /^            [a-z_]+:$/ {
      name = $1; sub(/:$/, "", name); next
    }
    /^              - / {
      if (name == "") next
      path = $0
      sub(/^ *- */, "", path)
      gsub(/'"'"'/, "", path)
      print name "\t" path
      next
    }
    /^      [a-z]/ { name = "" }
  ' "$f"
}

# The filter outputs a job's `if:` is gated on. Job blocks start at column 3.
job_filters() {
  local job_pattern="$1"
  awk -v pat="$job_pattern" '
    /^  [a-z][a-z0-9-]*:$/ {
      job = $1; sub(/:$/, "", job)
      injob = (job ~ pat)
      next
    }
    injob && /needs\.changes\.outputs\./ {
      line = $0
      while (match(line, /needs\.changes\.outputs\.[a-z_]+/)) {
        out = substr(line, RSTART, RLENGTH)
        sub(/.*outputs\./, "", out)
        print out
        line = substr(line, RSTART + RLENGTH)
      }
    }
  ' "$f" | sort -u
}

all_filters="$(filters)"
[ -n "$all_filters" ] || { echo "FAIL: parsed no path filters from $f"; exit 1; }

paths_of() {
  # Every path belonging to the named filters on stdin.
  local name
  while read -r name; do
    printf '%s\n' "$all_filters" | awk -F'\t' -v n="$name" '$1 == n { print $2 }'
  done | sort -u
}

deploy_paths="$(job_filters '^deploy-' | paths_of)"
[ -n "$deploy_paths" ] || { echo "FAIL: the deploy job is gated on no path filter"; exit 1; }

build_filters="$(job_filters '^build-')"
[ -n "$build_filters" ] || { echo "FAIL: found no build jobs to check"; exit 1; }

status=0
while read -r bf; do
  uncovered="$(
    printf '%s\n' "$bf" | paths_of | comm -23 - <(printf '%s\n' "$deploy_paths")
  )"
  if [ -n "$uncovered" ]; then
    echo "FAIL: build filter '$bf' gates a build the deploy job never fires on:"
    printf '         %s\n' $uncovered
    echo "       Add it to deploy-home-server's if:, or fold its paths into a filter that is already there."
    status=1
  fi
done <<<"$build_filters"

[ "$status" -eq 0 ] || exit 1
echo "PASS"
