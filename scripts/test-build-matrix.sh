#!/usr/bin/env bash
# Guard for the Talos migration multi-arch build (SDD homelab-migration Task 1).
# Asserts the CI build jobs matrix across BOTH a native arm64 leg (the mini
# stays live) and a native amd64 leg (the new Talos node), merged into a
# multi-arch manifest index via `docker buildx imagetools create`. No
# setup-qemu-action: both legs must be native runners, never emulated.
set -euo pipefail
f=.github/workflows/ci.yml
grep -q 'ubuntu-24.04-arm' "$f" || { echo "FAIL: arm64 leg must stay NATIVE"; exit 1; }
grep -q 'ubuntu-24.04\b'   "$f" || { echo "FAIL: amd64 leg missing"; exit 1; }
grep -q 'imagetools create' "$f" || { echo "FAIL: no manifest-merge step"; exit 1; }
echo "PASS"
