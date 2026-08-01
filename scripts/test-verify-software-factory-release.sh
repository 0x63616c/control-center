#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
fixture_dir="$(mktemp -d /tmp/software-factory-release-provenance-test.XXXXXX)"
trap 'rm -rf "$fixture_dir"' EXIT
mkdir -p "$fixture_dir/bin" "$fixture_dir/assets"

version=v0.1.2
commit=f4c58c15e7e297b7f44434ff2fadd543304c7689
manifest="$fixture_dir/assets/software-factory-images-$version.json"
jq --arg version "$version" --arg commit "$commit" \
  '.version = $version | .commit = $commit' \
  "$repo_root/scripts/testdata/software-factory-release-manifest.json" >"$manifest"
(
  cd "$fixture_dir/assets"
  shasum -a 256 "software-factory-images-$version.json" >SHA256SUMS
)

cat >"$fixture_dir/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2" = "release view" ]; then
  printf '{"tagName":"%s","isDraft":false,"isPrerelease":false,"url":"https://example.invalid","assets":[{"name":"SHA256SUMS"},{"name":"software-factory-images-%s.json"}]}\n' "$3" "$3"
elif [ "$1 $2" = "release download" ]; then
  destination=""
  for ((i = 1; i <= $#; i++)); do
    if [ "${!i}" = "--dir" ]; then
      j=$((i + 1))
      destination="${!j}"
    fi
  done
  cp "$FAKE_RELEASE_ASSETS/SHA256SUMS" "$destination/"
  cp "$FAKE_RELEASE_ASSETS/software-factory-images-$3.json" "$destination/"
elif [ "$1" = api ]; then
  printf '%s\n' "$FAKE_RELEASE_COMMIT"
else
  echo "unexpected gh invocation: $*" >&2
  exit 1
fi
SH

cat >"$fixture_dir/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
image_version="$4"
image="${image_version%:*}"
jq -r --arg image "$image" '.images[] | select(.image == $image) | .digest' \
  "$FAKE_RELEASE_MANIFEST"
SH
chmod +x "$fixture_dir/bin/gh" "$fixture_dir/bin/docker"

export PATH="$fixture_dir/bin:$PATH"
export FAKE_RELEASE_ASSETS="$fixture_dir/assets"
export FAKE_RELEASE_COMMIT="$commit"
export FAKE_RELEASE_MANIFEST="$manifest"

"$repo_root/scripts/verify-software-factory-release.sh" "$version" "$manifest" >/dev/null
echo "software-factory release provenance: release, checksum, tag, manifest, and registry agree"

jq '.commit = "0123456789abcdef0123456789abcdef01234567"' "$manifest" \
  >"$fixture_dir/wrong-expected.json"
if "$repo_root/scripts/verify-software-factory-release.sh" \
  "$version" "$fixture_dir/wrong-expected.json" >/dev/null 2>&1; then
  echo "release verifier accepted a different checked manifest" >&2
  exit 1
fi
echo "software-factory release provenance: a different checked manifest is rejected"
