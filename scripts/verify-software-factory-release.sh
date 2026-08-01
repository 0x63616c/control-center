#!/usr/bin/env bash
set -euo pipefail

version="${1:?usage: verify-software-factory-release.sh VERSION [EXPECTED_MANIFEST]}"
expected_manifest="${2:-}"
repository="0x63616c/software-factory"
artifact_dir="$(mktemp -d /tmp/software-factory-release-verify.XXXXXX)"
trap 'rm -rf "$artifact_dir"' EXIT

release_json="$(gh release view "$version" --repo "$repository" \
  --json tagName,isDraft,isPrerelease,assets,url)"
jq --exit-status --arg version "$version" '
  .tagName == $version and
  .isDraft == false and
  .isPrerelease == false and
  ([.assets[].name] | sort) ==
    ["SHA256SUMS", ("software-factory-images-" + $version + ".json")]
' <<<"$release_json" >/dev/null

gh release download "$version" --repo "$repository" --dir "$artifact_dir" \
  --pattern SHA256SUMS --pattern "software-factory-images-$version.json"

(
  cd "$artifact_dir"
  shasum -a 256 -c SHA256SUMS >&2
)

manifest="$artifact_dir/software-factory-images-$version.json"
tag_commit="$(gh api "repos/$repository/commits/$version" --jq .sha)"
jq --exit-status --arg version "$version" --arg commit "$tag_commit" '
  .version == $version and .commit == $commit
' "$manifest" >/dev/null

if [ -n "$expected_manifest" ]; then
  cmp "$expected_manifest" "$manifest"
fi

digest_map="$("$(git rev-parse --show-toplevel)/scripts/software-factory-release-manifest.sh" \
  "$manifest")"

while IFS=$'\t' read -r image digest; do
  published="$(docker buildx imagetools inspect "$image:$version" \
    --format '{{.Manifest.Digest}}')"
  test "$published" = "$digest"
done < <(jq -r '.images[] | [.image, .digest] | @tsv' "$manifest")

printf '%s\n' "$digest_map"
