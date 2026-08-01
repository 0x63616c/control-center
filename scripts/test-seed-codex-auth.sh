#!/usr/bin/env bash
# Hermetic public-interface tests for seed-codex-auth.sh --check. The fake
# kubectl returns key names only; no credential material enters the test.

set -euo pipefail

test_file="$(realpath "${BASH_SOURCE[0]}")"
here="$(dirname "$test_file")"

if [ "$(basename "$0")" = "kubectl" ]; then
  case "$*" in
    "cluster-info") exit 0 ;;
    "get namespace software-factory") exit 0 ;;
    *"get secret codex-auth"*)
      if [ "${FAKE_SECRET_EXISTS:-1}" = "0" ]; then
        exit 1
      fi
      case "$*" in
        *"go-template="*) printf '%s\n' "${FAKE_SECRET_KEYS:-}" ;;
      esac
      exit 0
      ;;
  esac
  printf 'unexpected kubectl invocation: %s\n' "$*" >&2
  exit 2
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/test-seed-codex-auth.XXXXXX")"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT
ln -s "$test_file" "$tmp/kubectl"

assert_check() {
  local name="$1"
  local keys="$2"
  local want_status="$3"
  local want_text="$4"
  local secret_exists="${5:-1}"
  local output="$tmp/${name}.out"

  set +e
  PATH="$tmp:$PATH" FAKE_SECRET_EXISTS="$secret_exists" FAKE_SECRET_KEYS="$keys" \
    "$here/seed-codex-auth.sh" --check >"$output" 2>&1
  local got_status=$?
  set -e

  if [ "$got_status" -ne "$want_status" ]; then
    printf '%s: exit status = %s, want %s\n' "$name" "$got_status" "$want_status" >&2
    cat "$output" >&2
    exit 1
  fi
  if ! grep -Fqx "$want_text" "$output"; then
    printf '%s: missing expected output: %s\n' "$name" "$want_text" >&2
    cat "$output" >&2
    exit 1
  fi
}

assert_check \
  auth_only \
  'auth.json' \
  0 \
  "SEEDED: secret 'codex-auth' in namespace 'software-factory' has the required 'auth.json' key"
assert_check \
  auth_and_worker_lease \
  $'auth.json\nrefresh_state.json' \
  0 \
  "SEEDED: secret 'codex-auth' in namespace 'software-factory' has the required 'auth.json' key"
assert_check \
  unknown_extra_key \
  $'auth.json\nunexpected.json' \
  1 \
  'SEEDED but with unexpected extra key(s): unexpected.json'
assert_check \
  missing_auth \
  'refresh_state.json' \
  1 \
  "NOT SEEDED: secret 'codex-auth' exists but has no 'auth.json' key"
assert_check \
  regex_near_misses \
  $'authXjson\nrefresh_stateXjson' \
  1 \
  "NOT SEEDED: secret 'codex-auth' exists but has no 'auth.json' key"
assert_check \
  missing_secret \
  '' \
  1 \
  "NOT SEEDED: secret 'codex-auth' does not exist in namespace 'software-factory'" \
  0

printf 'PASS: seed-codex-auth --check accepts only the worker-owned optional lease\n'
