#!/usr/bin/env bash
# Guard for infra/talos/talconfig.yaml: renders the machine config with
# talhelper into a scratch dir, then validates the rendered config with
# talosctl in metal mode. Catches schema errors (e.g. a duplicate top-level
# `machine:`/`cluster:` key across patches) before they reach real hardware.
#
# Requires: talhelper, talosctl (both on PATH; see infra/talos/README.md for
# versions). Needs SOPS_AGE_KEY to decrypt infra/talos/talsecret.sops.yaml —
# run this via scripts/secrets.sh so the age key comes from the macOS
# Keychain, never pass it on the command line.
#
# Usage:
#   scripts/secrets.sh scripts/test-talos-config.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TALOS_DIR="$HERE/../infra/talos"
OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT

for bin in talhelper talosctl; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "FAIL: $bin not found on PATH" >&2
    exit 1
  fi
done

if [ -z "${SOPS_AGE_KEY:-}" ] && [ -z "${SOPS_AGE_KEY_FILE:-}" ]; then
  echo "FAIL: SOPS_AGE_KEY (or SOPS_AGE_KEY_FILE) not set — run via scripts/secrets.sh" >&2
  exit 1
fi

cd "$TALOS_DIR"

if ! talhelper genconfig --out-dir "$OUT_DIR" --no-gitignore; then
  echo "FAIL: talhelper genconfig failed to render talconfig.yaml" >&2
  exit 1
fi

rendered="$OUT_DIR/prod-home-server.yaml"
if [ ! -f "$rendered" ]; then
  echo "FAIL: expected rendered config at $rendered" >&2
  exit 1
fi

if ! talosctl validate --mode metal --config "$rendered"; then
  echo "FAIL: talosctl validate rejected the rendered config" >&2
  exit 1
fi

echo "PASS"
