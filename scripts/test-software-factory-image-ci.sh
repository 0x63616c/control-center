#!/usr/bin/env bash
# Guard the complete software-factory image path: the registry is authoritative,
# while CI must build and collect a digest for every entry it declares.
set -euo pipefail

registry="${SOFTWARE_FACTORY_IMAGE_REGISTRY:-infra/src/services.ts}"
workflow="${SOFTWARE_FACTORY_IMAGE_WORKFLOW:-.github/workflows/ci.yml}"

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

status=0
while read -r image; do
  [ -n "$image" ] || continue
  job="build-$image"
  repository="www-$image"

  if ! grep -qE "^  ${job}:$" "$workflow"; then
    echo "FAIL: $image has no $job CI build job"
    status=1
  fi
  if ! grep -Fxq "${repository}:${image}" <<<"$digest_entries"; then
    echo "FAIL: $image has no ${repository}:${image} digest collection entry"
    status=1
  fi
done <<<"$factory_images"

[ "$status" -eq 0 ] || exit 1
echo "PASS"
