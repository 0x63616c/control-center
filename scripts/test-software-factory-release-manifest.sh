#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
fixture_dir="$(mktemp -d /tmp/software-factory-release-manifest-test.XXXXXX)"
trap 'rm -rf "$fixture_dir"' EXIT

manifest="$fixture_dir/software-factory-images-v0.1.0.json"
cat >"$manifest" <<'JSON'
{
  "version": "v0.1.0",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "platform": "linux/amd64",
  "images": [
    {"name":"api","image":"ghcr.io/0x63616c/software-factory-api","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
    {"name":"blobs","image":"ghcr.io/0x63616c/software-factory-blobs","digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
    {"name":"codec","image":"ghcr.io/0x63616c/software-factory-codec","digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
    {"name":"console","image":"ghcr.io/0x63616c/software-factory-console","digest":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},
    {"name":"relay","image":"ghcr.io/0x63616c/software-factory-relay","digest":"sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"},
    {"name":"run-worker","image":"ghcr.io/0x63616c/software-factory-run-worker","digest":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"},
    {"name":"worker","image":"ghcr.io/0x63616c/software-factory-worker","digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"}
  ]
}
JSON

expected='{"software-factory-api":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","software-factory-blobs":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","software-factory-codec":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","software-factory-console":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","software-factory-relay":"sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","software-factory-run-worker":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","software-factory-worker":"sha256:1111111111111111111111111111111111111111111111111111111111111111"}'
actual="$("$repo_root/scripts/software-factory-release-manifest.sh" "$manifest")"
test "$actual" = "$expected"

echo "software-factory release manifest: valid artifact emits the exact Pulumi digest map"

jq 'del(.images[] | select(.name == "worker"))' "$manifest" >"$fixture_dir/missing-worker.json"
if "$repo_root/scripts/software-factory-release-manifest.sh" \
  "$fixture_dir/missing-worker.json" >/dev/null 2>&1; then
  echo "release manifest without all seven images was accepted" >&2
  exit 1
fi

echo "software-factory release manifest: incomplete image set is rejected"

jq '(.images[] | select(.name == "api") | .image) = "ghcr.io/attacker/software-factory-api"' \
  "$manifest" >"$fixture_dir/wrong-repository.json"
if "$repo_root/scripts/software-factory-release-manifest.sh" \
  "$fixture_dir/wrong-repository.json" >/dev/null 2>&1; then
  echo "release manifest with an unexpected repository was accepted" >&2
  exit 1
fi

echo "software-factory release manifest: repositories are bound to the standalone project"

jq '.platform = "linux/arm64"' "$manifest" >"$fixture_dir/wrong-platform.json"
if "$repo_root/scripts/software-factory-release-manifest.sh" \
  "$fixture_dir/wrong-platform.json" >/dev/null 2>&1; then
  echo "release manifest for a non-production platform was accepted" >&2
  exit 1
fi

echo "software-factory release manifest: platform is exactly linux/amd64"

jq '.version = "main"' "$manifest" >"$fixture_dir/moving-version.json"
if "$repo_root/scripts/software-factory-release-manifest.sh" \
  "$fixture_dir/moving-version.json" >/dev/null 2>&1; then
  echo "release manifest without a stable SemVer version was accepted" >&2
  exit 1
fi

echo "software-factory release manifest: version is stable SemVer"

jq '.commit = "not-a-commit"' "$manifest" >"$fixture_dir/invalid-commit.json"
if "$repo_root/scripts/software-factory-release-manifest.sh" \
  "$fixture_dir/invalid-commit.json" >/dev/null 2>&1; then
  echo "release manifest without an immutable source commit was accepted" >&2
  exit 1
fi

echo "software-factory release manifest: source commit is immutable"

jq '(.images[] | select(.name == "worker") | .digest) = "sha256:mutable"' \
  "$manifest" >"$fixture_dir/invalid-digest.json"
if "$repo_root/scripts/software-factory-release-manifest.sh" \
  "$fixture_dir/invalid-digest.json" >/dev/null 2>&1; then
  echo "release manifest without immutable SHA-256 image digests was accepted" >&2
  exit 1
fi

echo "software-factory release manifest: every image is pinned by SHA-256 digest"
