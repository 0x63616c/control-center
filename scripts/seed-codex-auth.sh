#!/usr/bin/env bash
# Seeds the software-factory worker's codex credential Secret (#344).
#
# Pulumi deliberately does not own this Secret: the OAuth refresh token
# rotates on first use, so a value baked into the SOPS vault or a stack would
# be a corpse within a day (see CODEX_AUTH_SECRET_NAME's doc comment in
# infra/src/software-factory.ts). This script is the "out of band" apply that
# comment refers to.
#
# Usage:
#   scripts/seed-codex-auth.sh [--check] [--replace] [FILE]
#
#   FILE defaults to ~/.codex/auth.json (what `codex login` writes). Pass "-"
#   to read from stdin instead. The value never appears in argv, never
#   touches a pipe on its way to the cluster (kubectl reads the file itself),
#   and this script never prints it.
#
#   --check    report whether the Secret is seeded correctly; change nothing.
#              Exits 0 if auth.json is present with, at most, the worker-owned
#              refresh_state.json lease; non-zero otherwise.
#   --replace  required to overwrite an already-seeded Secret. Without it,
#              an existing Secret is left alone and the script exits 0.
#
# What it does, spelled out because a failure here surfaces identically to
# every other stage failure (every codex stage errors the same way): scale
# the worker to 0, wait for the pod to actually be gone, delete-then-create
# the Secret from the file (never --from-literal, never a dry-run|apply
# pipe — see docs/runbooks/software-factory-seed-codex-auth.md §1), scale
# back to 1. On a first seed (no Deployment yet) the scale/wait steps are
# skipped.
#
# See docs/runbooks/software-factory-seed-codex-auth.md for the full
# explanation, the failure-mode table, and why each of these steps exists.

set -euo pipefail

NAMESPACE="software-factory"
SECRET_NAME="codex-auth"
CREDENTIAL_KEY="auth.json"
LEASE_KEY="refresh_state.json"
DEPLOYMENT="software-factory-worker"
POD_LABEL="app=software-factory-worker"
WAIT_TIMEOUT="180s"

CHECK=0
REPLACE=0
SRC=""

usage() {
  echo "Usage: $0 [--check] [--replace] [FILE|-]" >&2
  exit 1
}

for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --replace) REPLACE=1 ;;
    -h|--help) usage ;;
    -) SRC="-" ;;
    -*) echo "FATAL: unknown flag '$arg'" >&2; usage ;;
    *)
      if [ -n "$SRC" ]; then
        echo "FATAL: only one FILE argument allowed" >&2
        usage
      fi
      SRC="$arg"
      ;;
  esac
done
[ -n "$SRC" ] || SRC="$HOME/.codex/auth.json"

command -v kubectl >/dev/null 2>&1 || { echo "FATAL: kubectl not found" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "FATAL: jq not found" >&2; exit 1; }

kubectl cluster-info >/dev/null 2>&1 || {
  echo "FATAL: no reachable cluster (check TALOSCONFIG/KUBECONFIG)" >&2
  exit 1
}
kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || {
  echo "FATAL: namespace '$NAMESPACE' not found" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# --check: report state only, touch nothing.
# ---------------------------------------------------------------------------
if [ "$CHECK" -eq 1 ]; then
  if ! kubectl -n "$NAMESPACE" get secret "$SECRET_NAME" >/dev/null 2>&1; then
    echo "NOT SEEDED: secret '$SECRET_NAME' does not exist in namespace '$NAMESPACE'"
    exit 1
  fi

  # Key names only — never values. See the runbook's "Verify — without
  # printing it" section for why this is written as a go-template rather
  # than jsonpath (a dotted key + jsonpath silently reads as 0 bytes, exit 0).
  keys="$(kubectl -n "$NAMESPACE" get secret "$SECRET_NAME" \
    -o go-template='{{range $k,$v := .data}}{{$k}}{{"\n"}}{{end}}')"

  if ! printf '%s\n' "$keys" | grep -Fqx "$CREDENTIAL_KEY"; then
    echo "NOT SEEDED: secret '$SECRET_NAME' exists but has no '$CREDENTIAL_KEY' key"
    echo "keys present: $(printf '%s' "$keys" | tr '\n' ' ')"
    exit 1
  fi

  # The worker writes its own lease after a healthy refresh. It is legitimate
  # state, not a second operator-seeded credential. Any other key is unsafe:
  # this check must still catch accidental Secret shape drift.
  extra="$(printf '%s\n' "$keys" | grep -Fvx -e "$CREDENTIAL_KEY" -e "$LEASE_KEY" || true)"
  if [ -n "$extra" ]; then
    echo "SEEDED but with unexpected extra key(s): $(printf '%s' "$extra" | tr '\n' ' ')"
    echo "(the worker may own '$LEASE_KEY'; do not seed it by hand)"
    exit 1
  fi

  echo "SEEDED: secret '$SECRET_NAME' in namespace '$NAMESPACE' has the required '$CREDENTIAL_KEY' key"
  exit 0
fi

# ---------------------------------------------------------------------------
# Apply path.
# ---------------------------------------------------------------------------
already_seeded=0
if kubectl -n "$NAMESPACE" get secret "$SECRET_NAME" >/dev/null 2>&1; then
  already_seeded=1
fi

if [ "$already_seeded" -eq 1 ] && [ "$REPLACE" -eq 0 ]; then
  echo "Secret '$SECRET_NAME' already exists in namespace '$NAMESPACE'. Doing nothing."
  echo "Pass --replace to seed a fresh credential over it (e.g. after 'codex login' rotated it)."
  exit 0
fi

# Read the credential without ever putting it in argv or on stdout. A
# tempfile is unavoidable for `kubectl create secret --from-file`, but it is
# 0600, under a private mktemp dir, and removed on every exit path.
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/seed-codex-auth.XXXXXX")"
chmod 700 "$WORKDIR"
TMP_AUTH="$WORKDIR/$CREDENTIAL_KEY"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

if [ "$SRC" = "-" ]; then
  umask 077
  cat >"$TMP_AUTH"
else
  [ -f "$SRC" ] || { echo "FATAL: '$SRC' not found (pass a path, or '-' for stdin)" >&2; exit 1; }
  umask 077
  cp "$SRC" "$TMP_AUTH"
fi
chmod 600 "$TMP_AUTH"

[ -s "$TMP_AUTH" ] || { echo "FATAL: '$SRC' is empty" >&2; exit 1; }

# Validate before applying — the same shape checks
# the standalone software-factory credential loader enforces at
# read time, run here so a bad seed fails loudly by name instead of as an
# undifferentiated stage failure later.
if ! jq -e . "$TMP_AUTH" >/dev/null 2>&1; then
  echo "FATAL: '$SRC' does not hold a JSON object" >&2
  exit 1
fi
if ! jq -e 'has("tokens") and (.tokens | type == "object")' "$TMP_AUTH" >/dev/null 2>&1; then
  echo "FATAL: '$SRC' carries no 'tokens' object" >&2
  exit 1
fi
if ! jq -e '(.tokens.access_token | type == "string") and (.tokens.access_token | length > 0)' "$TMP_AUTH" >/dev/null 2>&1; then
  echo "FATAL: '$SRC''s tokens.access_token is absent, not a string, or blank" >&2
  exit 1
fi
if ! jq -e '(.tokens.refresh_token | type == "string") and (.tokens.refresh_token | length > 0)' "$TMP_AUTH" >/dev/null 2>&1; then
  echo "FATAL: '$SRC''s tokens.refresh_token is absent, not a string, or blank" >&2
  echo "  (a blank refresh_token is the SANDBOX copy, not the real one — see the runbook §3)" >&2
  exit 1
fi

echo "Validated: '$SRC' parses as a codex auth.json with a non-blank access_token and refresh_token."

worker_exists=0
if kubectl -n "$NAMESPACE" get deployment "$DEPLOYMENT" >/dev/null 2>&1; then
  worker_exists=1
fi

if [ "$worker_exists" -eq 1 ]; then
  echo "Scaling deploy/$DEPLOYMENT to 0 before replacing the Secret..."
  kubectl -n "$NAMESPACE" scale deploy/"$DEPLOYMENT" --replicas=0
  echo "Waiting for the worker pod to actually go (timeout ${WAIT_TIMEOUT})..."
  kubectl -n "$NAMESPACE" wait --for=delete pod -l "$POD_LABEL" --timeout="$WAIT_TIMEOUT"
else
  echo "No deploy/$DEPLOYMENT yet — first seed, nothing to scale down."
fi

echo "Replacing secret '$SECRET_NAME' wholesale (clears any refresh_state.json lease)..."
kubectl -n "$NAMESPACE" delete secret "$SECRET_NAME" --ignore-not-found
kubectl -n "$NAMESPACE" create secret generic "$SECRET_NAME" \
  --from-file="$CREDENTIAL_KEY=$TMP_AUTH"

if [ "$worker_exists" -eq 1 ]; then
  echo "Scaling deploy/$DEPLOYMENT back to 1..."
  kubectl -n "$NAMESPACE" scale deploy/"$DEPLOYMENT" --replicas=1
fi

echo "Done. Verify with: $0 --check"
