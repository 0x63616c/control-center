#!/usr/bin/env bash
# Guard for the Talos migration multi-arch build (SDD homelab-migration Task 1).
# Asserts the CI build jobs matrix across BOTH a native arm64 leg (the mini
# stays live) and a native amd64 leg (the new Talos node), merged into a
# multi-arch manifest index via `docker buildx imagetools create`. No
# setup-qemu-action: both legs must be native runners, never emulated.
set -euo pipefail
f=.github/workflows/ci.yml
grep -q 'ubuntu-24.04-arm' "$f" || { echo "FAIL: arm64 leg must stay NATIVE"; exit 1; }
# NOTE: `\b` sits at a word/non-word boundary, and '4'|'-' IS such a boundary,
# so a bare `grep -q 'ubuntu-24.04\b'` also matches 'ubuntu-24.04-arm' and
# would still PASS if the amd64 leg were deleted. Anchor on the literal
# quoted ternary value (quote/EOL immediately after '04') so it's disjoint
# from the arm64 string.
grep -qE "ubuntu-24\.04['\"]" "$f" || { echo "FAIL: amd64 leg missing"; exit 1; }
grep -q 'imagetools create' "$f" || { echo "FAIL: no manifest-merge step"; exit 1; }
echo "PASS"
