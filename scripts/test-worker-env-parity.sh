#!/usr/bin/env bash
# Guard: the software-factory worker Deployment must set every environment
# variable the worker refuses to start without.
#
# The bug this exists to make impossible: `config.LoadWorker()` requires eight
# variables and defaults NONE, and the Deployment supplied three — one of them
# misnamed (`TEMPORAL_ADDRESS` for `TEMPORAL_HOST_PORT`). Nothing was red. Both
# sides typechecked, both sides had passing tests, and the two lists were simply
# never compared, so the first production run would have died on
# `TEMPORAL_HOST_PORT is required` and CrashLoopBackOff'd.
#
# The Go side is the source of truth: `workerEnvNames()` in internal/config is
# what the process actually enforces, so this reads THAT rather than a list
# copied into a shell script that would drift the same way.
#
# Deliberately conditional, and the condition is real rather than an escape
# hatch: if no worker Deployment is declared yet there is nothing that could
# fail to start, so there is nothing to assert. What must never happen is a
# declared Deployment checked against nothing — so a Deployment WITHOUT a
# readable Go manifest is a hard failure, not a skip.
set -euo pipefail

ts=infra/src/software-factory.ts
go_config=apps/software-factory/internal/config/worker.go

# Does a worker Deployment exist to check? Anchored on the image ref rather than
# the word "Deployment", since that is what makes it the worker's pod.
if ! grep -q 'ghcrImage("software-factory-worker"' "$ts" 2>/dev/null; then
  echo "SKIP: no software-factory worker Deployment declared in $ts yet; nothing can fail to start."
  exit 0
fi

if [ ! -f "$go_config" ]; then
  echo "FAIL: $ts declares a worker Deployment, but $go_config is missing, so its"
  echo "      required environment cannot be checked. That file is D1 (#340) —"
  echo "      the Deployment must not merge ahead of the config it is written against."
  exit 1
fi

# The names workerEnvNames() returns: the env* identifiers inside its body,
# resolved through the const block that defines them.
idents="$(
  awk '/^func workerEnvNames\(\)/, /^}/' "$go_config" |
    grep -oE '\benv[A-Za-z0-9_]+\b' || true
)"
[ -n "$idents" ] || {
  echo "FAIL: could not parse workerEnvNames() out of $go_config."
  echo "      Refusing to report parity against an empty list — that is the vacuous"
  echo "      check this guard exists to replace."
  exit 1
}

required=""
while read -r ident; do
  [ -n "$ident" ] || continue
  value="$(grep -oE "^[[:space:]]*$ident[[:space:]]*=[[:space:]]*\"[A-Z0-9_]+\"" "$go_config" |
    grep -oE '"[A-Z0-9_]+"' | tr -d '"' || true)"
  [ -n "$value" ] || {
    echo "FAIL: $ident is returned by workerEnvNames() but has no string constant in $go_config."
    exit 1
  }
  required="$required$value"$'\n'
done <<<"$idents"

required="$(printf '%s' "$required" | sort -u)"
count="$(printf '%s\n' "$required" | grep -c .)"

missing=""
while read -r name; do
  [ -n "$name" ] || continue
  # `name: "FOO"` is how every env entry in the Deployment is spelled, whether
  # its value is a literal, a secretKeyRef or a fieldRef.
  grep -qE "name: \"$name\"" "$ts" || missing="$missing  $name"$'\n'
done <<<"$required"

if [ -n "$missing" ]; then
  echo "FAIL: the worker Deployment in $ts does not set every variable the worker"
  echo "      requires. LoadWorker defaults none of these, so the pod would"
  echo "      CrashLoopBackOff on its first start:"
  printf '%s' "$missing"
  exit 1
fi

echo "PASS: the worker Deployment sets all $count variables workerEnvNames() requires."
