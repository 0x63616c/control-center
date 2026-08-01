#!/usr/bin/env bash
# Guard the standalone Software Factory consumer path: Pulumi's registry and
# the checked release manifest must declare the same complete image set, while
# WWW CI must not source those pins from its retired :main image family.
set -euo pipefail

registry="${SOFTWARE_FACTORY_IMAGE_REGISTRY:-infra/src/services.ts}"
workflow="${SOFTWARE_FACTORY_IMAGE_WORKFLOW:-.github/workflows/ci.yml}"
release_manifest="${SOFTWARE_FACTORY_RELEASE_MANIFEST:-infra/software-factory-release.json}"

factory_images="$({
  awk '
    /^const IMAGE_REPOSITORIES = \{/ { in_registry = 1; next }
    in_registry && /^} as const/ { exit }
    in_registry && /^[[:space:]]+"software-factory-[^"]+": \{/ {
      image = $1
      gsub(/[":]/, "", image)
      print image
    }
  ' "$registry"
} | sort -u)"

[ -n "$factory_images" ] || {
  echo "FAIL: parsed no software-factory images from $registry"
  exit 1
}

release_images="$(scripts/software-factory-release-manifest.sh "$release_manifest" | jq -r 'keys[]')"

if [ "$factory_images" != "$release_images" ]; then
  echo "FAIL: Pulumi's software-factory image set differs from $release_manifest" >&2
  diff -u <(printf '%s\n' "$factory_images") <(printf '%s\n' "$release_images") || true
  exit 1
fi

digest_entries="$(awk '
  /^[[:space:]]*for entry in / {
    line = $0
    sub(/^[[:space:]]*for entry in /, "", line)
    sub(/; do.*/, "", line)
    count = split(line, entries, " ")
    for (i = 1; i <= count; i++) print entries[i]
    exit
  }
' "$workflow")"

[ -n "$digest_entries" ] || {
  echo "FAIL: parsed no image-digest collection entries from $workflow"
  exit 1
}

if grep -qE '(^| )www-software-factory-[^ ]+:' <<<"$digest_entries"; then
  echo "FAIL: WWW deploy still collects mutable embedded software-factory image digests" >&2
  exit 1
fi

grep -Fq 'scripts/verify-software-factory-release.sh \' \
  "$workflow" || {
  echo "FAIL: deploy does not verify and source the checked software-factory release" >&2
  exit 1
}

echo "PASS"
